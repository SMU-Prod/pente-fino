import { drizzle } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import postgres from "postgres";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

/**
 * The database type every consumer takes. Both the postgres-js driver used
 * in production and the PGlite driver used in tests satisfy it, so nothing
 * downstream needs to know which one it got.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: Database | null = null;

// Deliberately not `new URL("../migrations", import.meta.url)`, unlike the
// otherwise-identical line in `testing.ts`: that exact call shape is also
// webpack's asset-module convention for bundling a *file* URL, and Next.js's
// build (this module - unlike `testing.ts` - is on the real production
// import path, through `apps/web`'s routes) statically rewrites it and then
// fails, because "../migrations" is a directory, not a single file webpack
// can bundle. Building the same path from `dirname()` + `join()` instead
// resolves identically at runtime without tripping that rewrite.
//
// `fileURLToPath`, not `.pathname`, on the module URL itself: on Windows a
// `file://` URL's `.pathname` keeps its leading slash, which breaks every fs
// call built from it.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Finding 3: E0 exists so all domain work can proceed with no external
 * account, but this used to throw the moment DATABASE_URL was unset - so
 * `pnpm --filter @pentefino/web dev` rendered the landing page and then
 * failed on the first API call. The design doc (§4.4) says the client
 * chooses its driver by the presence of the variable; this is that branch.
 *
 * File-backed (not in-memory, unlike the per-test PGlite in `testing.ts`),
 * under the same local data root every other local adapter already uses
 * (`LOCAL_DATA_ROOT`, see `packages/adapters/src/index.ts`), so state
 * survives a dev server restart instead of resetting on every reload.
 *
 * Migrations are applied through drizzle's own `migrate()` rather than by
 * re-executing every `.sql` file the way `testing.ts` does: `testing.ts`
 * builds a fresh in-memory database per test, so replaying every file from
 * scratch is safe and cheap. This database persists on disk across restarts,
 * so re-running a migration that already applied (`CREATE TABLE` with no
 * `IF NOT EXISTS`) must not error the second time - `migrate()` tracks what
 * already ran in its own bookkeeping table and skips it.
 *
 * Not awaited here, so `getUnscopedDb()` stays synchronous for every
 * existing caller (`withUser`'s default parameter, `container()`, ...) -
 * turning it async would ripple that signature change through every call
 * site with no session/db already threaded through. PGlite's own operation
 * queue is not enough on its own to make that safe: getting from "caller
 * calls db.insert(...)" to "PGlite actually receives the query" crosses
 * several microtask hops inside drizzle-orm, and those hops do not reliably
 * preserve issue-order against `migrate()`'s own, differently-shaped hops -
 * measured directly, a query issued right after `getUnscopedDb()` returned
 * could reach PGlite before the migration that creates its table did. So the
 * `client` handed to the returned `Database` is a thin wrapper, not the raw
 * one `migrate()` uses: its `query`/`transaction` - the only two methods
 * drizzle-orm's pglite driver ever calls - each await the migration promise
 * first. That is the actual guarantee; the queue is just what makes it cheap
 * (no query is ever left waiting once migrations are done).
 */
function createLocalFallback(): Database {
  const root = process.env.LOCAL_DATA_ROOT ?? join(process.cwd(), ".data");
  const dataDir = join(root, "db");
  // PGlite's file-backed driver does not create its own parent directory -
  // it fails with ENOENT deep inside its first query instead of at
  // construction time - so it has to exist up front.
  mkdirSync(dataDir, { recursive: true });
  // Deliberate: nobody touching this process should mistake a local
  // throwaway database for the real one.
  console.warn(
    `[pentefino] DATABASE_URL is not set - using a local PGlite database at ${dataDir}. ` +
      "This is for local development only; it is never used in production.",
  );
  const client = new PGlite(dataDir, { extensions: { pg_trgm } });
  const ready = migratePglite(drizzlePglite(client, { schema }), { migrationsFolder: MIGRATIONS_DIR });
  ready.catch((error: unknown) => {
    // Only path to surface a fatal local-db setup failure that nothing here
    // awaits. Any query already in flight through `guardedClient` below
    // still sees this same rejection through its own `await ready`.
    console.error("[pentefino] failed to apply migrations to the local fallback database", error);
  });

  const guardedClient = new Proxy(client, {
    get(target, prop) {
      // Always resolved and bound against `target`, never the proxy: a
      // getter or method relying on a private class field throws if it ever
      // runs with `this` set to the proxy instead of the real instance.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (prop === "query" || prop === "transaction") {
        return async (...args: unknown[]) => {
          await ready;
          return bound(...args);
        };
      }
      return bound;
    },
  });

  return drizzlePglite(guardedClient, { schema });
}

export function getUnscopedDb(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    // A silent local database serving production traffic would be far worse
    // than a crash: production must keep failing loudly when misconfigured.
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set");
    cached = createLocalFallback();
    return cached;
  }
  cached = drizzle(postgres(url), { schema });
  return cached;
}
