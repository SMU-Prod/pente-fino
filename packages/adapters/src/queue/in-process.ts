import { newId } from "@pentefino/core";
import type { TaskQueue } from "@pentefino/core/ports";

export type TaskHandler = (payload: Record<string, unknown>) => Promise<void>;

type EnqueueResult = { runId: string; deduplicated: boolean };

/**
 * Stand-in for Trigger.dev. Same task signature, but runs the handler inline
 * instead of on a durable worker. Durable waits of days (ADR-02) are an E5
 * concern; at E0 nothing waits.
 *
 * A caller that does not await `enqueue()` gets something that looks like
 * asynchronous work and is not: the handler runs in this process, so it only
 * finishes if this process stays alive. In dev and in tests it does. In a
 * serverless function it need not — the instance can be frozen or reclaimed
 * once its response is sent, killing a run part-way through. That is the
 * difference between this and the real adapter, and it is the whole reason
 * ADR-02 picked a durable worker rather than a background promise.
 *
 * A run is only remembered - and therefore only deduplicated - once its
 * handler actually resolves. If the handler throws, the failure propagates
 * to the caller (nothing here catches it) and the idempotency key is left
 * unclaimed, so a legitimate retry with the same key runs the handler again
 * instead of being silently treated as an already-completed step. A4 asks
 * for a completed step to have no second effect; it says nothing about
 * treating a failed one as done.
 *
 * That alone is not enough for A4: two enqueue() calls with the same key
 * issued before the first one resolves would both find the completed map
 * empty and both invoke the handler, which is exactly the duplicate-
 * delivery shape A4 exists to prevent. So in-flight runs are tracked too,
 * by promise, keyed by idempotency key. A concurrent duplicate awaits that
 * same promise instead of starting a second run, and receives the same
 * outcome - the same runId on success, the same rejection on failure. The
 * in-flight entry is removed once the run settles either way: on success
 * the completed map already holds the result, and on failure the key must
 * be free for a genuine retry.
 *
 * Task 1 (E3): a caller does not have to await the promise `enqueue()`
 * returns for the handler to run - it is invoked synchronously, inside this
 * function, before anything here awaits it, and it keeps running to
 * completion regardless of whether anyone is still listening. That is what
 * lets `POST /api/invoices/:id/process` fire ingestion and respond without
 * waiting for it: nothing had to change here for that, because a fire-and-
 * forget caller was always a valid way to use this queue. It is also why a
 * test that needs to know when a fire-and-forgotten run has actually
 * settled can just call `enqueue()` again with the same task and
 * idempotency key and await *that* - it transparently joins the run already
 * in flight (or reads back its completed result) through the exact
 * dedup path described above, rather than reaching for a `setTimeout` guess
 * or a test-only escape hatch that production code could stumble into.
 */
export function createInProcessQueue(handlers: Record<string, TaskHandler>): TaskQueue {
  const completed = new Map<string, string>(); // idempotencyKey -> runId
  const inFlight = new Map<string, Promise<EnqueueResult>>(); // idempotencyKey -> pending run

  return {
    async enqueue(task, payload, opts) {
      const key = opts?.idempotencyKey;
      if (key) {
        const runId = completed.get(key);
        if (runId) return { runId, deduplicated: true };

        const running = inFlight.get(key);
        if (running) {
          const { runId: sharedRunId } = await running;
          return { runId: sharedRunId, deduplicated: true };
        }
      }

      const handler = handlers[task];
      if (!handler) throw new Error(`no handler registered for task "${task}"`);

      const run = (async (): Promise<EnqueueResult> => {
        await handler(payload);
        return { runId: newId("run"), deduplicated: false };
      })();

      if (key) inFlight.set(key, run);

      try {
        const result = await run;
        if (key) completed.set(key, result.runId);
        return result;
      } finally {
        if (key) inFlight.delete(key);
      }
    },
  };
}
