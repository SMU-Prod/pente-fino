import { eq, sql } from "drizzle-orm";
import {
  maskCanonical, newId, normalizeDescription, runRules, validateInvoice,
} from "@pentefino/core";
import type { AiProvider, Storage } from "@pentefino/core/ports";
import type { EventType } from "@pentefino/core";
import { aiCalls, events, invoiceItems, invoices, type Database } from "@pentefino/db";

export type IngestDeps = {
  db: Database;
  storage: Storage;
  ai: AiProvider;
};

const EXTRACT_PROMPT_VERSION = 1;

type Stage = "extract" | "validate" | "persist";

/**
 * classify → extract → validate → mask → rules (PRD §9.2).
 *
 * At E0 there are no active rules, so a valid invoice lands on `analyzed`
 * with an empty finding list. The path is whole; the judgement is not there
 * yet.
 *
 * Ordering is load-bearing, not incidental (INV-007): validation runs
 * against the *raw* extraction, before masking, so a rejected invoice never
 * has a masked copy computed for it; masking then runs before anything is
 * written, so nothing ever reaches `invoices.canonical` or `invoice_items`
 * with PII still in it.
 *
 * A single try/catch wraps everything from the first status flip onward.
 * §9.2 draws a third terminal branch besides `analyzed` and `needs_review`:
 * `*→ failed` on "erro fatal". That is what an unexpected error becomes
 * here — the invoice is never left parked mid-pipeline with no trace of why
 * (A8): status moves to `failed` and an `invoice_failed` event records which
 * stage was running, then the original error is rethrown so the caller (the
 * queue today, a durable workflow's retry policy later) sees the failure
 * instead of a silent no-op.
 *
 * Two failure surfaces are checked deliberately, ahead of touching the AI
 * provider, rather than left to surface as an opaque extraction error:
 *   - the invoice row does not exist → thrown immediately, nothing to mark;
 *   - the file the invoice points at is missing from storage (an upload
 *     that was signed but never completed) → failed, without ever asking
 *     the AI provider about a file that isn't there.
 *
 * Idempotency (A4) has one hard guarantee and one accepted limitation:
 *   - an invoice already `analyzed` is a full no-op (a completed step has no
 *     second effect);
 *   - a retry from a genuinely intermediate status (the process crashed
 *     after flipping to `extracting` but before reaching `analyzed`) redoes
 *     the extraction rather than skipping it, because nothing durable
 *     captures a partial attempt to resume from. That does mean a crash in
 *     that narrow window can produce a second `ai_calls` row and a second
 *     `invoice_extracted` event for the same invoice — an honest ledger of
 *     two real attempts, not a duplicated final result. What must not
 *     happen either way is guaranteed: `invoice_items` rows survive a retry
 *     with the same ids (see the upsert below), so anything with a foreign
 *     key pointing at one is never cascade-deleted out from under it.
 */
export function createIngestTask(deps: IngestDeps) {
  const { db, storage, ai } = deps;

  return async function ingest(payload: Record<string, unknown>): Promise<void> {
    const invoiceId = String(payload.invoiceId);

    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!invoice) throw new Error(`invoice ${invoiceId} not found`);
    if (invoice.status === "analyzed") return; // A4: a completed run has no second effect

    // Captured as plain values, not read off `invoice` inside the closure:
    // TS narrowing of the `!invoice` check above does not reach across a
    // nested function boundary, so `record` referencing `invoice.userId`
    // directly would be typed as possibly-undefined again.
    const ownerUserId = invoice.userId;
    const ownerSessionId = invoice.sessionId;

    async function record(type: EventType, extra: Record<string, unknown> = {}) {
      await db.insert(events).values({
        id: newId("evt"), invoiceId, userId: ownerUserId, sessionId: ownerSessionId,
        type, payload: extra,
      });
    }

    let stage: Stage = "extract";
    try {
      await db.update(invoices).set({ status: "extracting" }).where(eq(invoices.id, invoiceId));

      if (!invoice.fileKey) {
        throw new Error(`invoice ${invoiceId} has no fileKey to extract from`);
      }
      const fileExists = await storage.exists(invoice.fileKey);
      if (!fileExists) {
        throw new Error(`storage object missing for invoice ${invoiceId}: ${invoice.fileKey}`);
      }

      const { canonical, usage } = await ai.extractInvoice({
        fileKey: invoice.fileKey, promptVersion: EXTRACT_PROMPT_VERSION,
      });

      await db.insert(aiCalls).values({
        id: newId("aic"), invoiceId, purpose: "extract",
        provider: usage.provider, model: usage.model, promptVersion: EXTRACT_PROMPT_VERSION,
        tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
        costUsd: usage.costUsd, latencyMs: usage.latencyMs,
      });
      await record("invoice_extracted", { confidence: canonical.extraction.confidence });

      stage = "validate";
      await db.update(invoices).set({ status: "validating" }).where(eq(invoices.id, invoiceId));
      const validation = validateInvoice(canonical);
      if (!validation.ok) {
        await db.update(invoices).set({ status: "needs_review" }).where(eq(invoices.id, invoiceId));
        await record("invoice_needs_review", { failures: validation.failures });
        return;
      }

      stage = "persist";
      const masked = maskCanonical(canonical);

      const rows = masked.sections.flatMap((section, sectionIndex) =>
        section.items.map((item, itemIndex) => ({
          id: newId("itm"),
          invoiceId,
          lineNo: sectionIndex * 1000 + itemIndex,
          section: section.name,
          description: item.description,
          normalizedDesc: normalizeDescription(item.description),
          amountCents: item.amountCents,
          qty: item.qty ?? null,
          unitPriceCents: item.unitPriceCents ?? null,
          periodRef: item.periodRef ?? null,
        })),
      );

      if (rows.length > 0) {
        // UPSERT, not delete-then-reinsert: `findings.itemId` carries
        // `onDelete: "cascade"`, so deleting a row a rerun is about to
        // recreate would silently take any finding pointed at it with it.
        // Keying on (invoiceId, lineNo) - stable across re-extraction of the
        // same invoice - lets a retry land on the same row and keep its id.
        await db.insert(invoiceItems).values(rows).onConflictDoUpdate({
          target: [invoiceItems.invoiceId, invoiceItems.lineNo],
          set: {
            section: sql`excluded.section`,
            description: sql`excluded.description`,
            normalizedDesc: sql`excluded.normalized_desc`,
            amountCents: sql`excluded.amount_cents`,
            qty: sql`excluded.qty`,
            unitPriceCents: sql`excluded.unit_price_cents`,
            periodRef: sql`excluded.period_ref`,
            updatedAt: sql`now()`,
          },
        });
      }

      const findings = runRules({
        invoice: masked,
        previous: null,
        rules: [],
        answers: {},
        references: { tariffs: [], flags: [] },
      });
      if (findings.length > 0) {
        throw new Error(`E0 expects no findings; rules arrive in E2 (got ${findings.length})`);
      }

      await db.update(invoices).set({
        status: "analyzed",
        canonical: masked,
        masked: true,
        periodStart: masked.period.start,
        periodEnd: masked.period.end,
        dueDate: masked.dueDate,
        totalCents: masked.totalCents,
        extractionQuality: masked.extraction.confidence,
      }).where(eq(invoices.id, invoiceId));

      await record("invoice_analyzed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update(invoices).set({ status: "failed" }).where(eq(invoices.id, invoiceId));
      await record("invoice_failed", { stage, message });
      throw error;
    }
  };
}
