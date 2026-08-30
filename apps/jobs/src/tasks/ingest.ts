import { and, eq, notInArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  maskCanonical, maskText, newId, normalizeDescription, runRules, validateInvoice,
} from "@pentefino/core";
import type { AiProvider, Storage } from "@pentefino/core/ports";
import type { EventType } from "@pentefino/core";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";

const { aiCalls, events, invoiceItems, invoices } = schema;

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
 * Pre-E1 fix, finding 4: every error this task throws is now tagged with a
 * structural `reason`, so a caller (the process route) can tell "the
 * invoice does not exist" from "extraction genuinely failed" without
 * inspecting the message text at all. A substring test on the message - the
 * route used to check `String(error).includes("not found")` - can be
 * spoofed by an unrelated failure whose own text happens to contain those
 * words (a provider replying "model … not found", say); a `reason` this
 * module attaches itself cannot.
 */
export type IngestErrorReason = "invoice_not_found" | "extraction_failed";

function taggedError(reason: IngestErrorReason, message: string): Error {
  return Object.assign(new Error(message), { reason });
}

/** Reads the `reason` a `taggedError` above attached, if any. */
export function ingestErrorReason(error: unknown): IngestErrorReason | undefined {
  if (typeof error !== "object" || error === null || !("reason" in error)) return undefined;
  const { reason } = error as { reason?: unknown };
  return reason === "invoice_not_found" || reason === "extraction_failed" ? reason : undefined;
}

/**
 * Stable identity for one invoice_items row, independent of where the item
 * sits in `masked.sections` (pre-E1 fix, line-key stability). `lineNo` - derived
 * purely from section/item position - used to be the upsert key, but
 * position is not identity: a re-extraction that finds one extra section
 * ahead of an existing one shifts every lineNo downstream, so the row that
 * used to sit at a given lineNo would silently inherit whatever item the
 * rerun now placed at that same lineNo, keeping its old id but acquiring a
 * different line's content - the exact foreign-key hazard (`findings.itemId`)
 * the upsert exists to avoid.
 *
 * Hashing (section, description, periodRef, amountCents) instead survives
 * reordering, insertion, and deletion of sections/items elsewhere in the
 * invoice. `occurrence` disambiguates two genuinely identical lines within
 * one invoice (same section, description, periodRef and amount) - without
 * it they would compute the same key and collide inside a single
 * `onConflictDoUpdate` batch, which Postgres rejects outright ("ON CONFLICT
 * DO UPDATE command cannot affect row a second time").
 */
function computeItemKey(
  section: string | undefined,
  description: string,
  periodRef: string | undefined,
  amountCents: number,
  occurrence: number,
): string {
  const raw = [section ?? "", description, periodRef ?? "", String(amountCents), String(occurrence)].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

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
    if (!invoice) throw taggedError("invoice_not_found", `invoice ${invoiceId} not found`);
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

      // Counts prior occurrences of the same (section, description,
      // periodRef, amountCents) tuple seen so far in this pass, so two
      // genuinely identical lines get distinct keys instead of colliding.
      const occurrenceCounts = new Map<string, number>();
      const rows = masked.sections.flatMap((section, sectionIndex) =>
        section.items.map((item, itemIndex) => {
          const occurrenceGroupKey = [section.name ?? "", item.description, item.periodRef ?? "", item.amountCents]
            .join("|");
          const occurrence = occurrenceCounts.get(occurrenceGroupKey) ?? 0;
          occurrenceCounts.set(occurrenceGroupKey, occurrence + 1);
          return {
            id: newId("itm"),
            invoiceId,
            lineNo: sectionIndex * 1000 + itemIndex,
            itemKey: computeItemKey(section.name, item.description, item.periodRef, item.amountCents, occurrence),
            section: section.name,
            description: item.description,
            normalizedDesc: normalizeDescription(item.description),
            amountCents: item.amountCents,
            qty: item.qty ?? null,
            unitPriceCents: item.unitPriceCents ?? null,
            periodRef: item.periodRef ?? null,
            meta: item.meta ?? null,
          };
        }),
      );

      if (rows.length > 0) {
        // UPSERT, not delete-then-reinsert: `findings.itemId` carries
        // `onDelete: "cascade"`, so deleting a row a rerun is about to
        // recreate would silently take any finding pointed at it with it.
        // Keying on (invoiceId, itemKey) - the item's own identity, stable
        // across a re-extraction that reorders or inserts sections/items
        // elsewhere in the invoice, unlike the position-derived lineNo this
        // used to key on - lets a retry land on the same row and keep its
        // id AND its own content.
        await db.insert(invoiceItems).values(rows).onConflictDoUpdate({
          target: [invoiceItems.invoiceId, invoiceItems.itemKey],
          set: {
            lineNo: sql`excluded.line_no`,
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

      // The upsert above only ever touches the `(invoiceId, itemKey)` pairs
      // *this* run reproduces - it inserts or updates, but nothing ever
      // deletes, so a rerun whose extraction has fewer lines than a prior
      // run left behind used to leave the extra rows in place forever,
      // permanently out of sync with `invoices.canonical`. This is a
      // targeted delete by itemKey, not a return to blanket
      // delete-then-reinsert: every row this run DID reproduce was just
      // upserted above and is excluded here, so its id (and anything
      // pointing at it) is untouched. Only a row whose item genuinely does
      // not exist in the current canonical is removed - and only that row's
      // own findings, themselves about an item that no longer exists,
      // cascade away with it (`findings.itemId` is `onDelete: "cascade"`).
      const currentItemKeys = rows.map((row) => row.itemKey);
      await db.delete(invoiceItems).where(
        currentItemKeys.length > 0
          ? and(eq(invoiceItems.invoiceId, invoiceId), notInArray(invoiceItems.itemKey, currentItemKeys))
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
      // Tags the original error in place - preserving its real message and
      // stack for logs - rather than replacing it, so `ingestErrorReason`
      // can classify it without losing anything a human debugging this
      // would want to see.
      throw Object.assign(error instanceof Error ? error : new Error(rawMessage), {
        reason: "extraction_failed" satisfies IngestErrorReason,
      });
    }
  };
}
