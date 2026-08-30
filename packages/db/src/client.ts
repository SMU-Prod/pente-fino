import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * The database type every consumer takes. Both the postgres-js driver used
 * in production and the PGlite driver used in tests satisfy it, so nothing
 * downstream needs to know which one it got.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: Database | null = null;

export function getUnscopedDb(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  cached = drizzle(postgres(url), { schema });
  return cached;
}
