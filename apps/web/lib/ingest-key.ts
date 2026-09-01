/**
 * The idempotency key `queue.enqueue()` below dedupes ingestion runs on.
 * It lives here rather than in the route because a Next.js route module
 * may only export the HTTP methods and a handful of config keys - exporting
 * anything else fails the build's generated route types, which `next build`
 * regenerates and a bare `tsc` run does not, so the error surfaces late.
 *
 * A test calls can call `enqueue("ingest", ..., {
 * idempotencyKey: ingestIdempotencyKey(id) })` a second time to observe the
 * *same* run this route just fired, deterministically: the queue's own dedup
 * contract (packages/adapters/src/queue/in-process.ts) guarantees a second
 * call with this key either joins the run still in flight or reads back its
 * completed result - it never re-invokes the handler. That is the public
 * `enqueue()` API used exactly as production already uses it, not a
 * test-only hook a production caller could stumble into by accident.
 */
export function ingestIdempotencyKey(invoiceId: string): string {
  return `ingest:${invoiceId}`;
}
