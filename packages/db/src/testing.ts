import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";
import { seedAll } from "./seeds/index.js";

// Re-exported so a real test file can build fixtures and assertions
// straight against the table definitions (`schema.invoices`, ...) without
// reaching for the package entry's own `schema` export, which
// `require-with-user` blocks outside packages/db regardless of caller. This
// subpath is itself gated by the same rule (INV-008, Blocker C1 / Bypass 3)
// to files whose path marks them as a real test — see `isTestFile` in
// `packages/config/eslint/rules/require-with-user.js`.
export { schema };

// `fileURLToPath`, not `.pathname` — on Windows a `file://` URL's `.pathname`
// keeps its leading slash (`/C:/Users/...`), which breaks every fs call built
// from it. `fileURLToPath` normalizes to a native OS path on every platform.
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export type TestDb = {
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
};

export type CreateTestDbOptions = {
  /**
   * A directory to keep the database in, instead of memory.
   *
   * The default (no `dataDir`) is an in-memory PGlite, which is what almost
   * every test wants: nothing to clean up, and nothing can leak between
   * files. But an in-memory database cannot outlive the process that holds
   * it, so it cannot express the one thing RF-180's acceptance is about —
   * *"reiniciar o serviço no meio de uma espera não perde o caso"*. A
   * file-backed instance can: closing it shuts the database process down,
   * and opening a new one against the same directory reads the same rows
   * back off disk. `apps/jobs/test/case-deadlines.test.ts` uses exactly
   * that to simulate a redeploy.
   *
   * Reopening a directory skips migrations and seeds — see below.
   */
  dataDir?: string;
};

/**
 * The marker that says a `dataDir` has been fully prepared.
 *
 * Written **last**, after every migration and every seed has succeeded, and
 * that ordering is the whole design. Probing a *table* instead — `cases`, say
 * — answers "the migration that creates it ran", not "preparation finished":
 * a directory where the first migration applied and a later one threw would
 * read as ready, and the reopen would surface as a confusing missing-column
 * error somewhere else entirely. With the marker, a half-prepared directory
 * reads as not ready and the next open replays the migrations, which fails
 * loudly and accurately (`relation "users" already exists`) instead.
 *
 * Only ever created for a file-backed database. An in-memory one cannot be
 * reopened, so it is always fresh by construction, and never adding the table
 * there keeps the default path byte-identical to what every other test in the
 * repo already gets.
 */
const READY_MARKER = "pentefino_test_db_ready";

/**
 * Has this directory already been migrated and seeded?
 *
 * It matters because the migration files are plain `CREATE TABLE` SQL, not
 * `CREATE TABLE IF NOT EXISTS`, and `seedAll` is only idempotent for the
 * seeds that say so. Replaying either against a prepared directory throws,
 * which would make a reopen look like a broken database rather than a
 * restart.
 *
 * `to_regclass` answers with the relation's oid, or null if it does not
 * exist, without raising the way a bare `::regclass` cast does.
 */
async function alreadyPrepared(client: PGlite): Promise<boolean> {
  const result = await client.query<{ present: string | null }>(
    `select to_regclass('public.${READY_MARKER}') as present`,
  );
  return result.rows[0]?.present != null;
}

/**
 * A Postgres for tests — in memory by default, or file-backed when given a
 * `dataDir`. Same dialect and same migrations as production, with no daemon
 * and no account, which is what lets `pnpm test` run anywhere, including CI.
 */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const { dataDir } = options;
  const client = dataDir ? new PGlite(dataDir, { extensions: { pg_trgm } })
    : new PGlite({ extensions: { pg_trgm } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");

  // An in-memory database is always fresh; only a directory can carry state
  // from a previous open, so only a directory is worth probing.
  const fresh = dataDir === undefined || !(await alreadyPrepared(client));
  if (fresh) {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  const db = drizzle(client, { schema });
  if (fresh) {
    // So every test starts from a database that looks like production
    // (A5, PRD §20.1/§20.3) instead of one only migrations touched. Skipped
    // on a reopen: the seeds are already in the rows that came back off disk,
    // and re-running them would be a write the "restart" never made.
    await seedAll(db);
    if (dataDir) await client.exec(`create table "${READY_MARKER}" ()`);
  }

  return {
    db,
    close: () => client.close(),
  };
}
