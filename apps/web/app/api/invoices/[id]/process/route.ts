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

  try {
    // Known gap, not a silent one (Task 14): the ingest task's own guard
    // against re-running a completed job is a plain read-then-act check
    // (`invoice.status === "analyzed"`, in `apps/jobs/src/tasks/ingest.ts`),
    // with nothing holding a lock between the read and the write. Two
    // genuinely concurrent requests for the same invoice can both read
    // "not yet analyzed" before either has written anything, and both go on
    // to make a real AI call. The in-process queue's idempotency-key dedup
    // above only protects concurrent `enqueue` calls within *this* process's
    // queue instance - real protection against that race needs a durable
    // queue with per-key locking or exactly-once execution, which is an E5
    // concern (ADR-02), not something to build here.
    await queue.enqueue("ingest", { invoiceId: id }, { idempotencyKey: `ingest:${id}` });
  } catch (error) {
    // Finding 4: this used to test `String(error).includes("not found")`,
    // which a genuine extraction failure could spoof if a provider's own
    // message happened to contain those words (e.g. "model … not found") -
    // returning a false not_found for an invoice that exists and merely
    // failed. `ingestErrorReason` reads a structural tag `apps/jobs`
    // attaches itself, so no message text is ever inspected here.
    //
    // - invoice_not_found: defense in depth. The ownership check above
    //   already guarantees the invoice row exists, so this should be
    //   unreachable through this route today; kept so a future race (or a
    //   caller that reaches the queue some other way) still degrades to
    //   the same not_found instead of a raw 500.
    // - extraction_failed: the real case this route used to get wrong. The
    //   invoice row and its `invoice_failed` event are already written
    //   correctly by the ingest task itself - only the HTTP translation
    //   was missing, leaving this to escape as a bare framework 500 with
    //   `extraction_failed` (422) sitting unused in the catalogue.
    const reason = ingestErrorReason(error);
    if (reason === "invoice_not_found") return apiError("not_found");
    if (reason === "extraction_failed") return apiError("extraction_failed");
    throw error;
  }
  return Response.json({ invoiceId: id, status: "queued" }, { status: 202 });
}
