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

/**
 * An in-memory Postgres for tests. Same dialect and same migrations as
 * production, with no daemon and no account — which is what lets `pnpm test`
 * run anywhere, including CI.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite({ extensions: { pg_trgm } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  const db = drizzle(client, { schema });
  // So every test starts from a database that looks like production
  // (A5, PRD §20.1/§20.3) instead of one only migrations touched.
  await seedAll(db);

  return {
    db,
    close: () => client.close(),
  };
}
