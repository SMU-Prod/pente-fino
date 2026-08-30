import { newId } from "@pentefino/core";
import type { TaskQueue } from "@pentefino/core/ports";

export type TaskHandler = (payload: Record<string, unknown>) => Promise<void>;

type EnqueueResult = { runId: string; deduplicated: boolean };

/**
 * Stand-in for Trigger.dev. Same task signature, but runs the handler inline
 * instead of on a durable worker. Durable waits of days (ADR-02) are an E5
 * concern; at E0 nothing waits.
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
