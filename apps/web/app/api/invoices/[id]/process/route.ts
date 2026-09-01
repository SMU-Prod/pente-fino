import { cookies } from "next/headers";
import { withUser } from "@pentefino/db";
import { ingestErrorReason } from "@pentefino/jobs";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

/**
 * INV-008: every route that touches user data goes through `withUser`. This
 * route's original design (per the task brief) enqueued ingestion for
 * whatever id appeared in the URL with no ownership check at all - any
 * caller who could see or guess an invoice id could trigger (and pay the AI
 * cost of) processing another session's invoice, even without being able to
 * read the result afterward. This resolves the caller's session first and
 * only enqueues for an invoice `withUser` actually returns for that
 * session; a wrong session, no session, and a genuinely nonexistent id all
 * come back as the same `not_found`, so the response never reveals whether
 * the id exists.
 */

/**
 * The idempotency key `queue.enqueue()` below dedupes ingestion runs on.
 * Exported (Task 1, E3) so a test can call `enqueue("ingest", ..., {
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

/**
 * Task 1 (E3) - the queue stops blocking the response. This route used to
 * `await queue.enqueue(...)`, so classify → extract → validate → persist all
 * ran inside the request: RF-141's progress stream had no interval to
 * stream over (the response only ever arrived once there was nothing left
 * to report), and RNF-01's "time to report" (p50 ≤ 8s, p95 ≤ 20s) was
 * unmeasurable as anything but this request's own duration.
 *
 * The fix is not a change to the queue at all. `createInProcessQueue`'s
 * `enqueue()` already starts the handler synchronously and lets it keep
 * running whether or not the caller awaits the promise it returns - see its
 * own doc comment - so a caller choosing not to await it was always enough
 * to run it "outside the response cycle". This route now does exactly that:
 * ownership is still confirmed synchronously below, then ingestion is fired
 * and the response goes out without waiting for it.
 *
 * ## This does not survive a serverless deploy, and that is why E5 exists
 *
 * Firing and forgetting works here because dev and the test suite run in a
 * long-lived Node process that stays alive to finish the work. A Vercel
 * Function does not: the platform is free to freeze or reclaim the instance
 * once the response is sent, so ingestion started this way can be killed
 * part-way through - after the AI has been paid for and before the findings
 * are written.
 *
 * The resemblance to Trigger.dev is only skin deep, and in the direction
 * that matters it is backwards. `trigger()` also returns immediately, but
 * it returns immediately *because the work runs on Trigger's own
 * infrastructure* rather than in a function that is about to be shut down.
 * That is exactly what ADR-02 chose it for. Until the real adapter lands in
 * E5, this route is correct locally and unsafe in production - so nothing
 * here should be deployed on the assumption that fire-and-forget completes.
 *
 * That has one real cost, and it is deliberate: a failure raised *inside*
 * ingestion can no longer become this route's HTTP status, because by the
 * time it happens the response has already gone out. Nothing about
 * *visibility* regresses, though - the ingest task's own try/catch
 * (apps/jobs/src/tasks/ingest.ts) already flips the invoice to `status:
 * "failed"` and writes an `invoice_failed` event before this route ever
 * ran; the 422 this route used to return was only ever a same-request echo
 * of that durable record, never the record itself. A client now learns
 * about a failure by reading the invoice back - `GET /report` already
 * returns the real `status`, untouched by this change - or, once RF-141's
 * SSE stream exists, by watching it reach `failed`.
 *
 * `not_found` keeps its job here: ownership is still checked before
 * anything is enqueued, so a wrong session, no session, and a genuinely
 * nonexistent id all still come back as 403/404 exactly as before.
 * `extraction_failed` loses its job in *this* route - it can no longer be
 * produced here - but the code stays real and reachable for whatever reads
 * a `failed` invoice synchronously later.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  const { db, queue } = container();
  const scoped = withUser({ sessionId }, db);
  const owned = (await scoped.invoices()).find((row) => row.id === id);
  if (!owned) return apiError("not_found");

  // Known gap, not a silent one (Task 14): the ingest task's own guard
  // against re-running a completed job is a plain read-then-act check
  // (`invoice.status === "analyzed"`, in `apps/jobs/src/tasks/ingest.ts`),
  // with nothing holding a lock between the read and the write. Two
  // genuinely concurrent requests for the same invoice can both read
  // "not yet analyzed" before either has written anything, and both go on
  // to make a real AI call. The in-process queue's idempotency-key dedup
  // below only protects concurrent `enqueue` calls within *this* process's
  // queue instance - real protection against that race needs a durable
  // queue with per-key locking or exactly-once execution, which is an E5
  // concern (ADR-02), not something to build here.
  //
  // Deliberately not awaited (see the doc comment above): the response
  // below goes out as soon as this call has been made, not once it settles.
  // A rejection here is already durably recorded by the ingest task itself
  // (`invoices.status = "failed"` + `invoice_failed`) - this `.catch` only
  // stops it from becoming an unhandled rejection, and logs it server-side
  // as a breadcrumb, since there is no HTTP response left to carry it.
  queue.enqueue("ingest", { invoiceId: id }, { idempotencyKey: ingestIdempotencyKey(id) }).catch((error: unknown) => {
    const reason = ingestErrorReason(error) ?? "unknown";
    console.error(`ingest failed for invoice ${id} after the response was already sent (reason: ${reason})`, error);
  });

  return Response.json({ invoiceId: id, status: "queued" }, { status: 202 });
}
