import { describe, expect, it, vi } from "vitest";
import { createInProcessQueue } from "./in-process.js";

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
});
