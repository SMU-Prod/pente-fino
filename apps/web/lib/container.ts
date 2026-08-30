import { buildAdapters, type TaskHandler } from "@pentefino/adapters";
// eslint-disable-next-line pentefino/require-with-user -- the ingest job runs system-wide, with no user session
import { getUnscopedDb, type Database } from "@pentefino/db";
import { createIngestTask } from "@pentefino/jobs";

export type ContainerOverrides = {
  /**
   * Lets tests swap the real Postgres client for the PGlite test harness
   * (`@pentefino/db/testing`) without setting DATABASE_URL or reaching for
   * the raw driver themselves - the only thing that changes is which
   * Database instance every route's `withUser(session, db)` call receives.
   * Defaults to the real `getUnscopedDb()` in every other context.
   */
  db?: Database;
  fixtures?: Record<string, unknown>;
};

/**
 * Composition root for the web app. The adapters are local until the real
 * credentials exist; nothing below this file knows the difference.
 *
 * The handler map is passed by reference and filled after the adapters are
 * built, because the ingest task needs the storage and ai adapters that the
 * same call produces. Building twice would give the queue a different
 * storage instance than the task it runs.
 */
export function container(overrides: ContainerOverrides = {}) {
  const db = overrides.db ?? getUnscopedDb();
  const handlers: Record<string, TaskHandler> = {};
  const adapters = buildAdapters(process.env, handlers, overrides.fixtures ?? {});
  handlers.ingest = createIngestTask({ db, storage: adapters.storage, ai: adapters.ai });
  return { db, ...adapters };
}
