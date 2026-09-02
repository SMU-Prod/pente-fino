import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { maskText, newId, type EventType } from "@pentefino/core";
import type { Storage } from "@pentefino/core/ports";
import type { TaskHandler } from "@pentefino/adapters";
import { resolveNow } from "../clock.js";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";

const { cases, events, invoices } = schema;

export type ExpireFilesDeps = {
  db: Database;
  storage: Storage;
};

const UPLOAD_TTL_DAYS = 30;
const POST_CLOSURE_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same cap ingest.ts uses for invoice_failed (INV-007): a storage error
// message is attacker- or provider-influenced text, not something to trust
// verbatim into an event payload.
const MAX_FAILURE_MESSAGE_LENGTH = 500;

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY_MS);
}

/**
 * RF-110: fileExpiresAt = createdAt + 30 days, or (the invoice's case
 * closedAt + 7 days) if that comes sooner. `earliestClosure` is the
 * earliest closedAt this run found among any cases tied to the invoice - a
 * defensive minimum, since nothing in the schema stops more than one case
 * existing against the same invoiceId, and the rule itself is already a
 * "whichever comes first" - an unclosed or still-open case (closedAt null)
 * contributes nothing, leaving the plain 30-day rule in force.
 */
function effectiveExpiry(invoice: { createdAt: Date }, earliestClosure: Date | undefined): Date {
  const uploadExpiry = addDays(invoice.createdAt, UPLOAD_TTL_DAYS);
  if (!earliestClosure) return uploadExpiry;
  const closureExpiry = addDays(earliestClosure, POST_CLOSURE_TTL_DAYS);
  return closureExpiry < uploadExpiry ? closureExpiry : uploadExpiry;
}

/**
 * RF-110's daily job.
 *
 * `fileExpiresAt` is written nowhere else in the codebase (confirmed by
 * grep before writing this) - this task is the single place that computes
 * and persists it, for every invoice that still has a file to manage
 * (`fileKey` not null), on every run, whether or not that invoice is
 * actually due yet. That is a deliberate choice over stamping a static
 * `createdAt + 30d` at upload time and leaving it there: a value written
 * once at upload could never move earlier when a case later closes, so
 * anything that reads the column (an admin view, a future "your file will
 * be removed on X" notice) would be lying about the +7-day rule the moment
 * it applied. Recomputing here instead keeps the column honest at the cost
 * of a few extra no-op-guarded writes - see the `expiresAt > now` branch
 * below, which only writes when the computed value actually changed.
 *
 * Deletion itself follows (A8): one invoice's storage failure must not sink
 * the run for every other invoice, so each delete is isolated in its own
 * try/catch. A thrown error is recorded as an `invoice_file_expiry_failed`
 * event rather than re-thrown, and `fileKey` is left untouched so the next
 * run retries it - the run itself never aborts. An object already missing
 * from storage is NOT a failure: `Storage.delete` is idempotent by contract
 * (the local adapter's `rmSync(..., { force: true })` never throws on
 * ENOENT), so that case reaches the same success path as a real deletion,
 * never retried again.
 *
 * Idempotent by construction (A4): once an invoice's `fileKey` is cleared,
 * the `isNotNull(invoices.fileKey)` filter below excludes it from every
 * later run, so a second run can neither re-delete it nor emit a second
 * `invoice_file_expired` event for it.
 *
 * What survives an expiry on purpose: `invoices.canonical` and every row in
 * `invoice_items`/`findings` are untouched - only `fileKey` is cleared and
 * `fileExpiresAt` is stamped with the moment it happened. `/report`
 * (apps/web/app/api/invoices/[id]/report/route.ts) never reads storage; it
 * serves the invoice row plus findings and totals straight from the
 * database, so an analyzed invoice whose file has since expired keeps
 * returning its full laudo exactly as before - `fileKey: null` in that
 * response is the only trace the file ever existed. No new state or error
 * path was needed there; this comment exists so that was a decision, not an
 * oversight.
 */
export function createExpireFilesTask(deps: ExpireFilesDeps): TaskHandler {
  const { db, storage } = deps;

  async function record(
    invoice: { id: string; userId: string | null; sessionId: string | null },
    type: EventType,
    extra: Record<string, unknown> = {},
  ) {
    await db.insert(events).values({
      id: newId("evt"), invoiceId: invoice.id, userId: invoice.userId, sessionId: invoice.sessionId,
      type, payload: extra,
    });
  }

  return async function expireFiles(payload: Record<string, unknown>): Promise<void> {
    const now = resolveNow(payload, "expire-files");

    const pending = await db.select().from(invoices).where(isNotNull(invoices.fileKey));
    if (pending.length === 0) return;

    const invoiceIds = pending.map((invoice) => invoice.id);
    const closedCases = await db.select({ invoiceId: cases.invoiceId, closedAt: cases.closedAt })
      .from(cases)
      .where(and(inArray(cases.invoiceId, invoiceIds), isNotNull(cases.closedAt)));

    const earliestClosureByInvoice = new Map<string, Date>();
    for (const { invoiceId, closedAt } of closedCases) {
      if (!closedAt) continue;
      const current = earliestClosureByInvoice.get(invoiceId);
      if (!current || closedAt < current) earliestClosureByInvoice.set(invoiceId, closedAt);
    }

    for (const invoice of pending) {
      const expiresAt = effectiveExpiry(invoice, earliestClosureByInvoice.get(invoice.id));

      if (expiresAt > now) {
        if (invoice.fileExpiresAt?.getTime() !== expiresAt.getTime()) {
          await db.update(invoices).set({ fileExpiresAt: expiresAt }).where(eq(invoices.id, invoice.id));
        }
        continue;
      }

      if (!invoice.fileKey) continue; // guarded by the query above; narrows for TS

      try {
        await storage.delete(invoice.fileKey);
      } catch (error) {
        const message = maskText(error instanceof Error ? error.message : String(error))
          .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
        await record(invoice, "invoice_file_expiry_failed", { message });
        continue; // this invoice's fileKey stays put, eligible for a retry next run
      }

      await db.transaction(async (tx) => {
        await tx.update(invoices).set({ fileKey: null, fileExpiresAt: expiresAt })
          .where(eq(invoices.id, invoice.id));
        await tx.insert(events).values({
          id: newId("evt"), invoiceId: invoice.id, userId: invoice.userId, sessionId: invoice.sessionId,
          type: "invoice_file_expired",
        });
      });
    }
  };
}
