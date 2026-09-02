import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@pentefino/db/testing";
import { container } from "../lib/container.js";

/**
 * `lib/container.ts` is the single place that knows which task name maps to
 * which handler - `expireFiles`, `ruleMetrics` and `ruleLifecycle` are all
 * registered there even though no scheduler enqueues them yet, precisely so
 * that map stays complete. `container.test.ts` covers the injected `db`
 * override; nothing covered the handler map itself, which is how RF-187's
 * dossier task came to be exported, tested and reachable from nowhere.
 *
 * The queue throws `no handler registered for task "..."` for a name it does
 * not know (`packages/adapters/src/queue/in-process.ts`), so enqueueing is
 * how a caller finds out - and how this file asserts it.
 *
 * `container()` memoizes for the lifetime of the module instance, so every
 * test here shares the one built by the first, and `ctx` is closed once at
 * the end rather than per test.
 */
describe("container() registers every task name this process can run", () => {
  let ctx: TestDb;

  afterEach(async () => {
    await ctx?.close();
  });

  // `container()` memoizes for the lifetime of the module, so everything
  // here shares the one database built by the first call — hence a single
  // test rather than one per task name.
  const SCHEDULED = ["caseDeadlines", "dossier", "expireFiles", "ruleMetrics", "ruleLifecycle"];

  it("resolves every scheduled task name, and refuses a name it does not know", async () => {
    ctx = await createTestDb();
    const { queue } = container({ db: ctx.db });

    // A fresh database gives every sweep nothing to do; what is under test
    // is that each name reaches a handler at all.
    //
    // This is the direction `test/routes/cron.test.ts` cannot cover. That
    // file mocks `container()`, so it proves the route's allowlist and
    // never the wiring behind it: a name can sit in `SCHEDULABLE`, get a
    // `vercel.json` entry, answer 200 in every route test, and resolve to
    // nothing at all. That is exactly what happened to `caseDeadlines` —
    // exported from `@pentefino/jobs`, allowlisted, scheduled hourly, and
    // registered nowhere.
    for (const task of SCHEDULED) {
      await expect(
        queue.enqueue(task, { now: "2026-09-02T12:00:00.000Z" }),
        `${task} is scheduled in vercel.json but reaches no handler`,
      ).resolves.toMatchObject({ deduplicated: false });
    }

    // Control: an unregistered name really does reject, so the assertions
    // above are about registration and not about a queue that accepts
    // anything.
    await expect(queue.enqueue("notATask", {}))
      .rejects.toThrow('no handler registered for task "notATask"');
  });
});
