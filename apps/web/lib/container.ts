import { buildAdapters, createUnpdfReader, type TaskHandler } from "@pentefino/adapters";
// eslint-disable-next-line pentefino/require-with-user -- the ingest job runs system-wide, with no user session
import { getUnscopedDb, type Database } from "@pentefino/db";
import {
  createCaseDeadlinesTask, createCaseRemindersTask, createDossierTask, createExpireFilesTask, createIngestTask,
  createRuleLifecycleTask, createRuleMetricsTask,
} from "@pentefino/jobs";

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

/**
 * Where the app lives, for the link a reminder e-mail carries.
 *
 * Refuses to guess in production, the same way `getSessionSecret` refuses a
 * placeholder secret: a reminder that points at the wrong host is a wrong
 * link in somebody's inbox, and an e-mail is the one output a later deploy
 * cannot take back. Local development gets the dev server's own origin,
 * because the alternative is that nothing runs locally at all.
 */
function resolveAppBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.APP_BASE_URL;
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "APP_BASE_URL is not set. Refusing to guess the host for a link sent by e-mail (RF-185).",
    );
  }
  return "http://localhost:3000";
}

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
  // RF-302/RF-126/RF-127 (Task 8, E2): the nightly rule-metrics materialiser
  // and the promotion/pause job that reads it. Same story as `expireFiles`
  // above - no scheduler is wired up yet to actually enqueue either of
  // these, but `container()` stays the single place that knows every task
  // name this process can run. `ruleLifecycle` must run after `ruleMetrics`
  // each night (it reads the `rule_metrics` rows the other one just wrote);
  // that ordering is a scheduler concern, not something either handler
  // enforces on its own.
  handlers.ruleMetrics = createRuleMetricsTask({ db });
  handlers.ruleLifecycle = createRuleLifecycleTask({ db });
  // RF-187 (Task 7, E5): produces the JEC dossier for every case that has
  // reached `jec_ready` and does not have one yet. Same story again - no
  // scheduler enqueues it in this slice, and it is registered here anyway so
  // there is no task in this process whose name this map does not know.
  handlers.dossier = createDossierTask({ db, storage: adapters.storage });
  // RF-180 (Task 3, E5): the deadline sweep. Unlike the four above, this one
  // is genuinely scheduled - `apps/web/app/api/cron/[task]/route.ts` and
  // `vercel.json` run it hourly. It was exported from `@pentefino/jobs` and
  // registered nowhere, which is the same "capable, not live" state every
  // job on this map was in before the scheduler existed, and the reason
  // `test/routes/cron.test.ts` now reads this file.
  handlers.caseDeadlines = createCaseDeadlinesTask({ db });
  // RF-185 (Task 6C, E5): the reminders.
  handlers.caseReminders = createCaseRemindersTask({
    db, mailer: adapters.mailer, appBaseUrl: resolveAppBaseUrl(),
  });
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
