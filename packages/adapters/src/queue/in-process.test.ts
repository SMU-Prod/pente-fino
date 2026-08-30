import { describe, expect, it, vi } from "vitest";
import { createInProcessQueue } from "./in-process.js";

/** A promise plus its resolve/reject, for controlling exactly when a handler settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("in-process queue", () => {
  it("runs the handler for the task", async () => {
    const handler = vi.fn(async () => {});
    const queue = createInProcessQueue({ ingest: handler });
    await queue.enqueue("ingest", { invoiceId: "inv_1" });
    expect(handler).toHaveBeenCalledWith({ invoiceId: "inv_1" });
  });

  it("returns a run id", async () => {
    const queue = createInProcessQueue({ ingest: async () => {} });
    expect((await queue.enqueue("ingest", {})).runId).toMatch(/^run_/);
  });

  it("deduplicates on the idempotency key, because A4 says every step can re-run", async () => {
    const handler = vi.fn(async () => {});
    const queue = createInProcessQueue({ ingest: handler });
    await queue.enqueue("ingest", { a: 1 }, { idempotencyKey: "k" });
    const second = await queue.enqueue("ingest", { a: 1 }, { idempotencyKey: "k" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.deduplicated).toBe(true);
  });

  it("throws for an unknown task rather than swallowing it", async () => {
    const queue = createInProcessQueue({});
    await expect(queue.enqueue("nope", {})).rejects.toThrow(/nope/);
  });

  it("propagates a handler failure to the caller instead of swallowing it", async () => {
    const queue = createInProcessQueue({
      ingest: async () => {
        throw new Error("boom");
      },
    });
    await expect(queue.enqueue("ingest", {})).rejects.toThrow(/boom/);
  });

  it("does not deduplicate a run whose handler failed, so a retry with the same key actually retries", async () => {
    let attempts = 0;
    const queue = createInProcessQueue({
      ingest: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
      },
    });

    await expect(queue.enqueue("ingest", {}, { idempotencyKey: "k" })).rejects.toThrow(/boom/);
    const second = await queue.enqueue("ingest", {}, { idempotencyKey: "k" });

    expect(attempts).toBe(2);
    expect(second.deduplicated).toBe(false);
  });

  it("does not invoke the handler twice for a concurrent duplicate issued before the first resolves", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const queue = createInProcessQueue({
      ingest: async () => {
        calls += 1;
        await gate.promise;
      },
    });

    const first = queue.enqueue("ingest", { a: 1 }, { idempotencyKey: "k" });
    const second = queue.enqueue("ingest", { a: 1 }, { idempotencyKey: "k" });

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(secondResult.runId).toBe(firstResult.runId);
    expect(secondResult.deduplicated).toBe(true);
  });

  it("propagates the same failure to a concurrent duplicate, invokes the handler only once, and leaves the key free for a real retry", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const queue = createInProcessQueue({
      ingest: async () => {
        calls += 1;
        if (calls === 1) {
          await gate.promise;
          return;
        }
      },
    });

    const first = queue.enqueue("ingest", {}, { idempotencyKey: "k" });
    const second = queue.enqueue("ingest", {}, { idempotencyKey: "k" });

    gate.reject(new Error("boom"));

    await expect(first).rejects.toThrow(/boom/);
    await expect(second).rejects.toThrow(/boom/);
    expect(calls).toBe(1);

    const third = await queue.enqueue("ingest", {}, { idempotencyKey: "k" });
    expect(calls).toBe(2);
    expect(third.deduplicated).toBe(false);
  });
});
