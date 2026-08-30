import { newId } from "@pentefino/core";
import type { TaskQueue } from "@pentefino/core/ports";

export type TaskHandler = (payload: Record<string, unknown>) => Promise<void>;

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
 */
export function createInProcessQueue(handlers: Record<string, TaskHandler>): TaskQueue {
  const completed = new Map<string, string>(); // idempotencyKey -> runId

  return {
    async enqueue(task, payload, opts) {
      const key = opts?.idempotencyKey;
      if (key) {
        const runId = completed.get(key);
        if (runId) return { runId, deduplicated: true };
      }

      const handler = handlers[task];
      if (!handler) throw new Error(`no handler registered for task "${task}"`);

      await handler(payload);

      const runId = newId("evt").replace("evt_", "run_");
      if (key) completed.set(key, runId);
      return { runId, deduplicated: false };
    },
  };
}
