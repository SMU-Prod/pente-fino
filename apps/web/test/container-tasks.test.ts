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

  it("runs the RF-187 dossier task by name, and refuses a name it does not know", async () => {
    ctx = await createTestDb();
    const { queue } = container({ db: ctx.db });

    // No case has reached `jec_ready` in a fresh database, so the handler
    // selects nothing and does nothing - what is under test is that the
    // name resolves to a handler at all.
    await expect(queue.enqueue("dossier", { now: "2026-08-31T12:00:00.000Z" }))
      .resolves.toMatchObject({ deduplicated: false });

    // Control: an unregistered name really does reject, so the assertion
    // above is about registration and not about a queue that accepts
    // anything.
    await expect(queue.enqueue("notATask", {}))
      .rejects.toThrow('no handler registered for task "notATask"');
  });
});
