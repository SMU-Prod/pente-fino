import type { EventType } from "@pentefino/core";

/**
 * §8.2's SSE shape for `GET /api/invoices/:id/status`. `status` mirrors the
 * `invoices.status` value the event marks; `step` is the same information in
 * the named-step vocabulary §8.2 and §13.3 want on screen (never a mute
 * spinner - every wait shows a named step).
 */
export type ProgressMessage = {
  status: "queued" | "extracting" | "validating" | "analyzed" | "needs_review" | "failed";
  step: "classifying" | "extracting" | "validating" | "done" | "needs_review" | "failed";
  progressPct: number;
};

/**
 * One entry per pipeline transition the ingest task's own `events` writes
 * cover (see `packages/core/src/events.ts`'s doc comment on why
 * `invoice_processing_started` had to be added there for this task) - an
 * event type with no entry here (`report_viewed`, `finding_created`,
 * `card_shared`, ...) carries no progress step and is skipped by whatever
 * reads this map, not treated as an error: the same `events` row this stream
 * reads from also carries every other event this invoice's session ever
 * produced (a re-read of the report, say), and none of that is progress.
 */
const EVENT_PROGRESS: Partial<Record<EventType, ProgressMessage>> = {
  invoice_uploaded: { status: "queued", step: "classifying", progressPct: 0 },
  invoice_processing_started: { status: "extracting", step: "extracting", progressPct: 25 },
  invoice_extracted: { status: "validating", step: "validating", progressPct: 65 },
  invoice_analyzed: { status: "analyzed", step: "done", progressPct: 100 },
  invoice_needs_review: { status: "needs_review", step: "needs_review", progressPct: 100 },
  invoice_failed: { status: "failed", step: "failed", progressPct: 100 },
};

/** The three ways ingestion can stop. Any one of them ends the stream. */
const TERMINAL_EVENT_TYPES = new Set<EventType>(["invoice_analyzed", "invoice_needs_review", "invoice_failed"]);

/** The minimal shape `createStatusStream` needs from an `events` row. */
export type InvoiceEventRow = { id: string; type: string; occurredAt: Date };

const DEFAULT_POLL_INTERVAL_MS = 200;

export const SSE_HEADERS: HeadersInit = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

function encodeMessage(encoder: TextEncoder, message: ProgressMessage): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
}

/**
 * Builds the SSE body for RF-141's progress stream. `fetchEvents` is the
 * caller's already-ownership-checked read (`scoped.eventsForInvoice(id)` in
 * the route) - this function only turns rows it is handed into messages, it
 * never queries anything itself, so it carries no session and cannot leak
 * one invoice's events into another's stream.
 *
 * Polls `fetchEvents` on an interval and re-reads the *whole* trail each
 * time, diffing against event ids already sent (`seen`) rather than trying
 * to track a cursor - the ingest task's own transactions (finding 2, in
 * ingest.ts) already guarantee a status change and its event commit
 * together, so a plain re-read is never at risk of seeing one without the
 * other, and the invoice's total event count is small enough that
 * re-fetching it every tick is not a real cost.
 *
 * Three behaviours this makes possible, each handled explicitly:
 *
 *   - A client connecting after the pipeline already reached a terminal
 *     event does not wait on a transition that will never come: the very
 *     first read runs synchronously, before any timer starts, and replays
 *     every event already on record up to and including the terminal one,
 *     then closes.
 *   - A client that disconnects mid-stream (closes the tab, navigates away)
 *     is handled by `cancel()`, which the platform calls when the consumer
 *     goes away, and by listening for `options.signal` aborting (the same
 *     `AbortSignal` the route's `Request` carries) - either one stops the
 *     poll timer so it does not keep querying the database forever for a
 *     reader that no longer exists.
 *   - An invoice that reaches `needs_review` or `failed` instead of
 *     `analyzed` ends the stream the same way `analyzed` does, saying which
 *     via `status`/`step` before closing - RF-141 does not promise a happy
 *     ending, only that the client learns the real one.
 */
export function createStatusStream(
  fetchEvents: () => Promise<InvoiceEventRow[]>,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let onAbort: (() => void) | undefined;

  function stop() {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (onAbort && options.signal) {
      options.signal.removeEventListener("abort", onAbort);
      onAbort = undefined;
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      function closeSafely() {
        if (stopped) return;
        stop();
        try {
          controller.close();
        } catch {
          // The consumer may already have gone away (a disconnect racing
          // this same tick) - closing an already-closed/errored controller
          // throws, and there is nothing left to report it to.
        }
      }

      onAbort = closeSafely;
      if (options.signal) {
        if (options.signal.aborted) {
          closeSafely();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      async function tick(): Promise<void> {
        if (stopped) return;
        let rows: InvoiceEventRow[];
        try {
          rows = await fetchEvents();
        } catch (error) {
          stop();
          controller.error(error);
          return;
        }
        if (stopped) return; // disconnected while that read was in flight

        let reachedTerminal = false;
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          const message = EVENT_PROGRESS[row.type as EventType];
          if (!message) continue;
          controller.enqueue(encodeMessage(encoder, message));
          if (TERMINAL_EVENT_TYPES.has(row.type as EventType)) reachedTerminal = true;
        }
        if (reachedTerminal) closeSafely();
      }

      await tick();
      if (stopped) return;

      timer = setInterval(() => {
        tick().catch(() => {
          // tick() already reports its own failures via controller.error();
          // this only guards against something escaping that path.
        });
      }, intervalMs);
    },
    cancel() {
      stop();
    },
  });
}
