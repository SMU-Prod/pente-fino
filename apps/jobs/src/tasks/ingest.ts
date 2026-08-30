import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  maskCanonical, maskText, newId, normalizeDescription, runRules, validateInvoice,
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

// Caps how much of a thrown error's message ends up in `invoice_failed`.
// Long enough to keep a useful diagnostic, short enough that a provider
// echoing back a large chunk of malformed input cannot turn the event log
// into a second, unmasked copy of the invoice.
const MAX_FAILURE_MESSAGE_LENGTH = 500;

type Stage = "extract" | "validate" | "persist";

/**
 * extract → validate → mask → rules (PRD §9.2).
 *
 * §9.2's own diagram opens with a `classify` step - issuer detection,
 * RF-105 / RF-106 - that this task does not perform. At E0 there is only a
 * fixture extractor and no heuristic that inspects the file for a CNPJ or a
 * header keyword; `issuerId` on the `invoices` row always arrives from
 * whatever created it before this task ever runs, and this task never reads
 * or writes it. Issuer detection is real work that belongs to the real
 * extractor arriving in E1 - narrating a step that does not exist here would
 * make this comment the thing that is wrong, not the code.
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
 *     happen either way is guaranteed: an `invoice_items` row a rerun still
 *     reproduces survives with the same id (see the upsert below), so
 *     anything with a foreign key pointing at it is never cascade-deleted
 *     out from under it. A row for a line the rerun does NOT reproduce is
 *     removed - `invoice_items` must match `invoices.canonical`, not just
 *     grow - taking only that row's own findings with it.
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

    // Takes the executor as a parameter, rather than closing over `db`,
    // so a status change and its event can be recorded through the same
    // `tx` and therefore commit or roll back together (finding 2 below).
    async function recordVia(executor: Database, type: EventType, extra: Record<string, unknown> = {}) {
      await executor.insert(events).values({
        id: newId("evt"), invoiceId, userId: ownerUserId, sessionId: ownerSessionId,
        type, payload: extra,
      });
    }
    const record = (type: EventType, extra: Record<string, unknown> = {}) => recordVia(db, type, extra);

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
        // RF-108 specifies a second attempt with a larger model before
        // landing here, only going to `needs_review` if that second attempt
        // also fails. That retry is not implemented: at E0 there is only a
        // fixture provider, so a "second attempt" would replay the exact
        // same fixture and fail identically - theatre, not a real retry.
        // Going straight to `needs_review` on the first failure is a
        // deliberate, temporary gap. Whoever wires in the real AI provider
        // at E1 must close it then; this comment exists so they find the
        // obligation here instead of rediscovering it.
        await db.transaction(async (tx) => {
          await tx.update(invoices).set({ status: "needs_review" }).where(eq(invoices.id, invoiceId));
          await recordVia(tx, "invoice_needs_review", { failures: validation.failures });
        });
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
          meta: item.meta ?? null,
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
            meta: sql`excluded.meta`,
            updatedAt: sql`now()`,
          },
        });
      }

      // The upsert above only ever touches the `(invoiceId, lineNo)` pairs
      // *this* run reproduces - it inserts or updates, but nothing ever
      // deletes, so a rerun whose extraction has fewer lines than a prior
      // run left behind used to leave the extra rows in place forever,
      // permanently out of sync with `invoices.canonical`. This is a
      // targeted delete by lineNo, not a return to blanket
      // delete-then-reinsert: every row this run DID reproduce was just
      // upserted above and is excluded here, so its id (and anything
      // pointing at it) is untouched. Only a row whose line genuinely does
      // not exist in the current canonical is removed - and only that row's
      // own findings, themselves about a line that no longer exists,
      // cascade away with it (`findings.itemId` is `onDelete: "cascade"`).
      const currentLineNos = rows.map((row) => row.lineNo);
      await db.delete(invoiceItems).where(
        currentLineNos.length > 0
          ? and(eq(invoiceItems.invoiceId, invoiceId), notInArray(invoiceItems.lineNo, currentLineNos))
          : eq(invoiceItems.invoiceId, invoiceId),
      );

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

      // Wrapped in a transaction (finding 2): `analyzed` is the one status
      // the guard at the top of this function treats as permanently done,
      // so it is also the one status a crash between the update and the
      // event insert could strand forever, with no retry ever able to add
      // the missing `invoice_analyzed` event. A single transaction makes
      // the pair all-or-nothing instead.
      await db.transaction(async (tx) => {
        await tx.update(invoices).set({
          status: "analyzed",
          canonical: masked,
          masked: true,
          periodStart: masked.period.start,
          periodEnd: masked.period.end,
          dueDate: masked.dueDate,
          totalCents: masked.totalCents,
          extractionQuality: masked.extraction.confidence,
        }).where(eq(invoices.id, invoiceId));

        await recordVia(tx, "invoice_analyzed");
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      // INV-007 does not stop at the happy path: a real provider that
      // echoes part of a malformed completion back into its error message
      // could otherwise write invoice content straight into this event's
      // payload. Run it through the same masking helper as the canonical,
      // and cap its length so a provider that echoes back a large chunk of
      // input cannot turn the event log into a second copy of the invoice.
      const message = maskText(rawMessage).slice(0, MAX_FAILURE_MESSAGE_LENGTH);
      await db.transaction(async (tx) => {
        await tx.update(invoices).set({ status: "failed" }).where(eq(invoices.id, invoiceId));
        await recordVia(tx, "invoice_failed", { stage, message });
      });
      throw error;
    }
  };
}
