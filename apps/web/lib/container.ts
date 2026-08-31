import { buildAdapters, createUnpdfReader, type TaskHandler } from "@pentefino/adapters";
// eslint-disable-next-line pentefino/require-with-user -- the ingest job runs system-wide, with no user session
import { getUnscopedDb, type Database } from "@pentefino/db";
import { createExpireFilesTask, createIngestTask } from "@pentefino/jobs";

export type ContainerOverrides = {
  /**
   * Lets tests swap the real Postgres client for the PGlite test harness
   * (`@pentefino/db/testing`) without setting DATABASE_URL or reaching for
   * the raw driver themselves - the only thing that changes is which
   * Database instance every route's `withUser(session, db)` call receives.
   * Defaults to the real `getUnscopedDb()` in every other context.
   *
   * Only read the first time `container()` builds the singleton below - see
   * the memoization note on `container()` itself.
   */
  db?: Database;
  fixtures?: Record<string, unknown>;
};

type Container = { db: Database } & ReturnType<typeof buildAdapters>;

function buildContainer(overrides: ContainerOverrides): Container {
  const db = overrides.db ?? getUnscopedDb();
  const handlers: Record<string, TaskHandler> = {};
  const adapters = buildAdapters(process.env, handlers, overrides.fixtures ?? {});
  handlers.ingest = createIngestTask({
    db, storage: adapters.storage, ai: adapters.ai, reader: createUnpdfReader(),
  });
  // RF-110: the daily file-expiry job runs system-wide too - no route
  // enqueues it today (there is no scheduler wired up yet in this slice),
  // but registering it here alongside `ingest` keeps `container()` the one
  // place that knows which task name maps to which handler.
  handlers.expireFiles = createExpireFilesTask({ db, storage: adapters.storage });
  return { db, ...adapters };
}

let cached: Container | null = null;

/**
 * Composition root for the web app. The adapters are local until the real
 * credentials exist; nothing below this file knows the difference.
 *
 * Memoized for the lifetime of the process (Task 14, finding 1). A Next.js
 * route handler is re-invoked on every request; a `container()` that called
 * `buildContainer` fresh each time would also hand out a brand-new
 * `createInProcessQueue` - with empty dedup maps - on every call. The
 * idempotency key `/api/invoices/[id]/process` passes to `queue.enqueue()`
 * would then never find a prior run, because no prior run's queue would
 * still be around to remember it: two separate HTTP requests would each get
 * their own queue, so idempotency would only ever appear to work within a
 * single call, never across the two real requests it exists to protect.
 * Building once per process and reusing that same `queue` (and the rest of
 * the adapters) across every later call is what lets the idempotency key do
 * anything at all between two separate requests.
 *
 * The handler map is passed by reference and filled after the adapters are
 * built, because the ingest task needs the storage and ai adapters that the
 * same call produces. Building twice would give the queue a different
 * storage instance than the task it runs.
 *
 * `overrides` is only consulted while building the singleton, i.e. on the
 * first call in the process; every later call - with or without overrides -
 * returns that same cached instance. A test that needs a specific `db` (or
 * AI fixtures) must call `container(overrides)` itself before anything else
 * in that process does, priming the singleton before a route's own no-args
 * `container()` call would otherwise build it from the real environment.
 */
export function container(overrides: ContainerOverrides = {}): Container {
  if (!cached) cached = buildContainer(overrides);
  return cached;
}
