import { describe, expect, it, vi } from "vitest";
import { createStatusStream, type InvoiceEventRow } from "../lib/status-stream.js";

type Row = InvoiceEventRow;

function row(id: string, type: string, occurredAt = new Date()): Row {
  return { id, type, occurredAt };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: unknown[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith("data:")) messages.push(JSON.parse(line.slice("data:".length).trim()));
    }
  }
  return messages;
}

/** A tiny interval, safe here because `fetchEvents` below never touches real I/O. */
const FAST_INTERVAL_MS = 5;

describe("createStatusStream", () => {
  it("replays an already-complete trail on the very first read, with no need to wait for a poll", async () => {
    let calls = 0;
    const fetchEvents = vi.fn(async (): Promise<Row[]> => {
      calls += 1;
      return [row("1", "invoice_uploaded"), row("2", "invoice_processing_started"), row("3", "invoice_extracted"), row("4", "invoice_analyzed")];
    });

    const stream = createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS });
    const messages = await readAll(stream);

    expect(messages).toEqual([
      { status: "queued", step: "classifying", progressPct: 0 },
      { status: "extracting", step: "extracting", progressPct: 25 },
      { status: "validating", step: "validating", progressPct: 65 },
      { status: "analyzed", step: "done", progressPct: 100 },
    ]);
    // A late-connecting client learns the outcome from the very first,
    // synchronous read - the interval never has to fire at all.
    expect(calls).toBe(1);
  });

  it("emits only the events not already sent on each poll, in order, until a terminal one closes the stream", async () => {
    const batches: Row[][] = [
      [row("1", "invoice_uploaded")],
      [row("1", "invoice_uploaded"), row("2", "invoice_processing_started")],
      [row("1", "invoice_uploaded"), row("2", "invoice_processing_started"), row("3", "invoice_extracted"), row("4", "invoice_analyzed")],
    ];
    let call = 0;
    const fetchEvents = vi.fn(async (): Promise<Row[]> => batches[Math.min(call++, batches.length - 1)]!);

    const messages = await readAll(createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS }));

    expect(messages).toEqual([
      { status: "queued", step: "classifying", progressPct: 0 },
      { status: "extracting", step: "extracting", progressPct: 25 },
      { status: "validating", step: "validating", progressPct: 65 },
      { status: "analyzed", step: "done", progressPct: 100 },
    ]);
  });

  it("skips an event type outside the pipeline vocabulary instead of erroring", async () => {
    const fetchEvents = vi.fn(async (): Promise<Row[]> => [
      row("1", "invoice_uploaded"),
      row("2", "report_viewed"), // not a progress event - must not appear, and must not break the ones that follow
      row("3", "invoice_analyzed"),
    ]);

    const messages = await readAll(createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS }));
    expect(messages).toEqual([
      { status: "queued", step: "classifying", progressPct: 0 },
      { status: "analyzed", step: "done", progressPct: 100 },
    ]);
  });

  it("ends the stream at needs_review rather than analyzed, saying which", async () => {
    const fetchEvents = vi.fn(async (): Promise<Row[]> => [
      row("1", "invoice_uploaded"),
      row("2", "invoice_needs_review"),
    ]);
    const messages = await readAll(createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS }));
    expect(messages.at(-1)).toEqual({ status: "needs_review", step: "needs_review", progressPct: 100 });
  });

  it("ends the stream at failed rather than analyzed, saying which", async () => {
    const fetchEvents = vi.fn(async (): Promise<Row[]> => [
      row("1", "invoice_uploaded"),
      row("2", "invoice_failed"),
    ]);
    const messages = await readAll(createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS }));
    expect(messages.at(-1)).toEqual({ status: "failed", step: "failed", progressPct: 100 });
  });

  it("stops polling once the AbortSignal fires, and enqueues nothing more afterward", async () => {
    const controller = new AbortController();
    // Deliberately never terminal: the only thing that should end this
    // stream is the abort below, not a race against a poll that happens to
    // land first.
    const fetchEvents = vi.fn(async (): Promise<Row[]> => [row("1", "invoice_uploaded")]);

    const stream = createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS, signal: controller.signal });
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    controller.abort();
    const after = await reader.read();
    expect(after.done).toBe(true);

    // Whether the poll timer had even been created yet by the moment of
    // abort is a genuine race (the very first tick's data can reach this
    // test before `start()`'s own continuation gets to `setInterval` at
    // all) - asserting on `clearInterval` directly would be asserting on
    // that race's outcome. What must hold regardless is the outward
    // behaviour: no further poll happens after the signal fires.
    const callsAtAbort = fetchEvents.mock.calls.length;
    await new Promise((resolve) => { setTimeout(resolve, FAST_INTERVAL_MS * 20); });
    expect(fetchEvents.mock.calls.length).toBe(callsAtAbort);
  });

  it("stops polling when the reader cancels the stream, matching the platform's own disconnect path", async () => {
    const fetchEvents = vi.fn(async (): Promise<Row[]> => [row("1", "invoice_uploaded")]);

    const stream = createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    const callsAtCancel = fetchEvents.mock.calls.length;
    await new Promise((resolve) => { setTimeout(resolve, FAST_INTERVAL_MS * 20); });
    expect(fetchEvents.mock.calls.length).toBe(callsAtCancel);
  });

  it("errors the stream (rather than looping forever) when the underlying read fails", async () => {
    let call = 0;
    const fetchEvents = vi.fn(async (): Promise<Row[]> => {
      call += 1;
      if (call === 1) return [row("1", "invoice_uploaded")];
      throw new Error("db unreachable");
    });
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const stream = createStatusStream(fetchEvents, { intervalMs: FAST_INTERVAL_MS });
    const reader = stream.getReader();
    await reader.read(); // the first, successful tick

    await expect(reader.read()).rejects.toThrow("db unreachable");
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
