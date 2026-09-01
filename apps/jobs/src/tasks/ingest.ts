import { and, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  detectIssuer, extractionQuality, MAX_PAGES, maskCanonical, maskText, newId,
  normalizeDescription, runRules, sniffMimeType, validateInvoice,
} from "@pentefino/core";
import type { ActiveRule } from "@pentefino/core";
import type { AiProvider, DocumentReader, ReadDocument, Storage } from "@pentefino/core/ports";
import type { EventType } from "@pentefino/core";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";

const {
  aiCalls, events, findings: findingsTable, invoiceItems, invoices, issuers, prompts, rules,
} = schema;

export type IngestDeps = {
  db: Database;
  storage: Storage;
  reader: DocumentReader;
  /**
   * Absent, not merely a provider that fails, means "no AI provider is
   * configured at all" - see the doc comment below for what that does to
   * the pipeline. A fixture provider that throws for an unregistered file
   * key is a different situation entirely: that provider IS configured, it
   * just does not recognise this particular file, and that stays a genuine
   * `failed`.
   */
  ai?: AiProvider;
};

const EXTRACT_PROMPT_SLUG = "extract";

// Caps how much of a thrown error's message ends up in `invoice_failed`.
// Long enough to keep a useful diagnostic, short enough that a provider
// echoing back a large chunk of malformed input cannot turn the event log
// into a second, unmasked copy of the invoice.
const MAX_FAILURE_MESSAGE_LENGTH = 500;

type Stage = "classify" | "extract" | "validate" | "persist";

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
 * classify → extract → validate → mask → rules (PRD §9.2).
 *
 * `classify` is real now, and it runs entirely ahead of any AI call:
 *
 *   1. read the stored bytes (the missing-object failure below already
 *      covered an absent file; this is what actually fetches it);
 *   2. `sniffMimeType` the real bytes, never the caller's declared type
 *      (RF-104) - a file that is not one of the four accepted types is
 *      rejected before anything tries to parse it;
 *   3. for a PDF, `reader.read` it; a page count over RF-104's limit of
 *      twelve goes to `needs_review` with the count in its event, and no AI
 *      call is ever made for it;
 *   4. `extractionQuality` scores what actually came out of the file and
 *      picks RF-107's route ("text" below the 0.6 threshold means "vision"
 *      instead); the score is persisted to `invoices.extractionQuality`
 *      immediately, so it survives even if a later step stops the pipeline;
 *   5. `detectIssuer` reads the same text against the `issuers` table,
 *      before the model ever sees anything (RF-105). An issuer the
 *      heuristic cannot place still gets a report, under generic rules,
 *      through a fresh `issuers` row with `status: "unknown"` (RF-106) -
 *      never a guess, which would silently outrank those generic rules in
 *      E2 (RF-123);
 *   6. only then is the provider called, with the route the score picked;
 *      for text, the pages the reader already produced, so the model
 *      transcribes what was actually extracted instead of re-reading the
 *      file itself; for vision, the file's own bytes (RF-107's other
 *      route, where there is no usable text to hand over instead) - plus,
 *      for either route, the active `extract` prompt's body loaded from
 *      the `prompts` table (A5) right here, not a literal in the provider:
 *      an `AiProvider` adapter has no database dependency of its own (see
 *      the doc comment on `ExtractInput.promptBody`), so resolving the
 *      active row is this job's responsibility, once per call.
 *
 * With no AI provider configured at all (`deps.ai` absent, not merely a
 * provider that fails on this one file - see the note on `IngestDeps`), the
 * pipeline stops right there, at `needs_review`, with a message a person can
 * act on. It never falls back to reconstructing invoice structure from the
 * text with regex: A1 says the model transcribes and the engine judges, and
 * inventing structure here would make this step exactly what A1 exists to
 * prevent.
 *
 * At E0 there were no active rules, so a valid invoice lands on `analyzed`
 * with an empty finding list. That is still true today - rules arrive in
 * E2 - so the path is whole; the judgement is not there yet.
 *
 * Ordering is load-bearing, not incidental (INV-007): validation runs
 * against the *raw* extraction, before masking, so a rejected invoice never
 * has a masked copy computed for it; masking then runs before anything is
 * written, so nothing ever reaches `invoices.canonical` or `invoice_items`
 * with PII still in it. The classify stage's own new field - the quality
 * score - is no exception: it is a number derived from unmasked text, but it
 * is not itself PII, and INV-007 applies to it exactly as it does to every
 * other field this task persists.
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
 * Four failure surfaces are checked deliberately, ahead of touching the AI
 * provider, rather than left to surface as an opaque extraction error:
 *   - the invoice row does not exist → thrown immediately, nothing to mark;
 *   - the file the invoice points at is missing from storage (an upload
 *     that was signed but never completed) → failed;
 *   - the file's real bytes are not one of the four accepted types
 *     (RF-104) → failed, whatever the caller declared;
 *   - a PDF's page count is over RF-104's limit → needs_review, not failed:
 *     the file is real and reachable, it is simply past what this pipeline
 *     is willing to send to a model.
 * None of these four ever reaches the AI provider - that is the whole point
 * of checking them first.
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
  const { db, storage, reader, ai } = deps;

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

    let stage: Stage = "classify";
    try {
      // Task 2 (E3): status and event land in the same transaction, same
      // reason the needs_review/failed/analyzed transitions below already do
      // it (finding 2) - a crash between the two would otherwise strand the
      // invoice at `extracting` with no `invoice_processing_started` row to
      // show a poller anything happened at all.
      await db.transaction(async (tx) => {
        await tx.update(invoices).set({ status: "extracting" }).where(eq(invoices.id, invoiceId));
        await recordVia(tx, "invoice_processing_started");
      });

      if (!invoice.fileKey) {
        throw new Error(`invoice ${invoiceId} has no fileKey to extract from`);
      }
      const bytes = await storage.get(invoice.fileKey);
      if (!bytes) {
        throw new Error(`storage object missing for invoice ${invoiceId}: ${invoice.fileKey}`);
      }

      const sniffed = sniffMimeType(bytes);
      if (!sniffed) {
        throw new Error(
          `file for invoice ${invoiceId} does not sniff as an accepted type (RF-104): ${invoice.fileKey}`,
        );
      }

      // RF-104's page limit and the text/no-text distinction unpdf reports
      // are both PDF concepts. An accepted image (RF-103's photo path) has
      // neither a page tree nor a text layer to speak of, so it is treated
      // as a single, textless "page" and always routed to vision below -
      // there is nothing here for a text reader to find.
      const doc: ReadDocument = sniffed === "application/pdf"
        ? await reader.read(bytes)
        : { pages: [], pageCount: 1, hasTextLayer: false };

      if (doc.pageCount > MAX_PAGES) {
        await db.transaction(async (tx) => {
          await tx.update(invoices).set({ status: "needs_review" }).where(eq(invoices.id, invoiceId));
          await recordVia(tx, "invoice_needs_review", {
            reason: "page_limit_exceeded", pageCount: doc.pageCount, maxPages: MAX_PAGES,
          });
        });
        return;
      }

      const quality = extractionQuality(doc);
      await db.update(invoices).set({ extractionQuality: quality.score }).where(eq(invoices.id, invoiceId));

      // RF-105/RF-106: detected straight off the text unpdf already read,
      // before a single AI call. Reading `issuers` directly, rather than
      // through `withUser`, is the same system-scoped access every other
      // query in this job already uses (see the eslint-disable at the top
      // of this file) - there is no session here to scope to.
      const issuerRows = await db.select({
        id: issuers.id, slug: issuers.slug, displayName: issuers.displayName,
        cnpj: issuers.cnpj, aliases: issuers.aliases,
      }).from(issuers);
      const candidates = issuerRows.map((row) => ({ ...row, aliases: row.aliases ?? [] }));
      const issuerMatch = detectIssuer(doc.pages.join("\n"), candidates);

      let issuerId: string;
      if (issuerMatch.issuerId) {
        issuerId = issuerMatch.issuerId;
      } else {
        // RF-106: nothing about a failed detection - no CNPJ, no alias -
        // identifies WHICH issuer this is, so a fresh `unknown` row is what
        // the invoice gets instead of a guess. One row per unmatched
        // invoice, deliberately: nothing here distinguishes two unrelated
        // unknown issuers from each other, so merging them into one shared
        // row would itself be an invented identity.
        issuerId = newId("iss");
        await db.insert(issuers).values({
          id: issuerId,
          slug: `unknown-${issuerId}`,
          category: "telecom",
          displayName: "Emissor não identificado",
          cnpj: null,
          aliases: [],
          sections: [],
          playbook: null,
          status: "unknown",
        });
      }
      await db.update(invoices).set({ issuerId }).where(eq(invoices.id, invoiceId));

      if (!ai) {
        // A1: the model transcribes, the engine judges. With no provider to
        // do that transcription, the honest stop is here - right after the
        // text and its quality score exist, right before anything would
        // otherwise have to invent structure (regex over the text, say) to
        // fake what only a real model call does.
        await db.transaction(async (tx) => {
          await tx.update(invoices).set({ status: "needs_review" }).where(eq(invoices.id, invoiceId));
          await recordVia(tx, "invoice_needs_review", {
            reason: "ai_not_configured",
            message:
              "No AI provider is configured; extraction stopped after reading the file's text " +
              "and cannot proceed to structured invoice data without a model.",
          });
        });
        return;
      }

      // A5: the prompt body is a versioned database row, never a literal
      // baked into the provider - see the doc comment on
      // `ExtractInput.promptBody`. A missing active row is a genuine
      // deploy misconfiguration (seeding is expected to have run - see
      // `packages/db/src/seeds/prompts.ts`), surfaced the same way every
      // other unexpected failure in this task is: caught below, `failed`.
      const [activePrompt] = await db.select().from(prompts)
        .where(and(eq(prompts.slug, EXTRACT_PROMPT_SLUG), eq(prompts.status, "active")));
      if (!activePrompt) {
        throw new Error(`no active "${EXTRACT_PROMPT_SLUG}" prompt found in the prompts table (A5)`);
      }

      stage = "extract";
      const { canonical, usage } = await ai.extractInvoice({
        fileKey: invoice.fileKey,
        promptVersion: activePrompt.version,
        promptBody: activePrompt.body,
        mode: quality.route,
        ...(quality.route === "text"
          ? { pages: doc.pages }
          : { file: { bytes, mimeType: sniffed } }),
      });

      await db.insert(aiCalls).values({
        id: newId("aic"), invoiceId, purpose: "extract",
        provider: usage.provider, model: usage.model, promptVersion: activePrompt.version,
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

      // RF-120: the caller's own query - every `active`/`shadow` rule whose
      // category matches this invoice's category, plus any rule specific to
      // this exact issuer. The engine's own category filter (`engine.ts`)
      // refuses a category mismatch too, but that is defence in depth, not
      // a replacement for this query doing it right in the first place.
      const ruleRows = await db.select().from(rules).where(and(
        inArray(rules.status, ["active", "shadow"]),
        or(
          and(eq(rules.category, masked.issuer.category), isNull(rules.issuerId)),
          eq(rules.issuerId, issuerId),
        ),
      ));
      const activeRules: ActiveRule[] = ruleRows.map((row) => ({
        slug: row.slug,
        version: row.version,
        spec: row.spec,
        confidenceBase: row.confidenceBase,
        shadow: row.status === "shadow",
        legalBasis: row.legalBasis,
        issuerId: row.issuerId,
        category: row.category,
      }));
      // Built from the very rows `activeRules` came from, so every finding
      // `runRules` returns for a real (non-aggregate) rule is guaranteed to
      // resolve here - see the "should be unreachable" guard below.
      const ruleIdByRef = new Map(ruleRows.map((row) => [`${row.slug}@${row.version}`, row.id]));

      // The same issuer's most recent already-analyzed cycle, if any - the
      // single `previous` invoice a handful of evaluators compare against
      // (delta.ts's deltas, pattern.ts's `requireRecurrence`).
      // `EvaluationContext` carries at most one previous invoice, a known
      // limitation the rules that need it already document (see
      // lexicon.ts/deterministic.ts's own "1-cycle proxy" comments).
      const ownerFilter = ownerUserId
        ? eq(invoices.userId, ownerUserId)
        : eq(invoices.sessionId, ownerSessionId!);
      const [previousRow] = await db.select({ canonical: invoices.canonical }).from(invoices)
        .where(and(
          eq(invoices.issuerId, issuerId),
          ownerFilter,
          eq(invoices.status, "analyzed"),
          ne(invoices.id, invoiceId),
          lt(invoices.periodStart, masked.period.start),
        ))
        .orderBy(desc(invoices.periodStart))
        .limit(1);

      const findings = runRules({
        invoice: masked,
        previous: previousRow?.canonical ?? null,
        rules: activeRules,
        // No route persists a user's answer to a `confirm`-kind question
        // yet (see confirm.ts's own doc comment on answer keying) - every
        // confirm rule therefore always evaluates as "unanswered" here,
        // which is the honest state of the world today, not a shortcut
        // taken by this wiring.
        answers: {},
        // RN-040/041's ANEEL reference tables have no import pipeline yet,
        // and `ReferenceTariff.dscBaseTarifa` - the field `reference.ts`'s
        // own evaluator filters on - is not even a column on
        // `reference_tariffs` today (see `references.ts`'s own doc comment).
        // There is nothing honest to load here yet, so this stays empty
        // rather than faking a shape the schema cannot back.
        references: { tariffs: [], flags: [] },
      });

      // RF-128's `cluster:` aggregate has no backing `rules` row - its
      // `ruleSlug` is synthetic (see engine.ts's own "Clustering key" doc
      // comment) and `findings.ruleId` is NOT NULL, FK'd to `rules`. It is
      // deliberately never persisted here: `/report`'s own `buildAggregates`
      // (apps/web/app/api/invoices/[id]/report/route.ts) already recomputes
      // the identical view at read time, from the individually-persisted
      // member findings' `invoiceItems.section` - so nothing is lost by not
      // storing the synthetic row a second time under an invented rule
      // reference. Its members (real, non-aggregate findings) ARE persisted
      // below like any other finding.
      const persistableFindings = findings.filter((finding) => !finding.ruleSlug.startsWith("cluster:"));

      // Wrapped in a transaction (finding 2): `analyzed` is the one status
      // the guard at the top of this function treats as permanently done,
      // so it is also the one status a crash between the update and the
      // event insert could strand forever, with no retry ever able to add
      // the missing `invoice_analyzed` event. A single transaction makes
      // the invoice, its findings, their events, and `invoice_analyzed`
      // all land together or not at all.
      await db.transaction(async (tx) => {
        await tx.update(invoices).set({
          status: "analyzed",
          canonical: masked,
          masked: true,
          periodStart: masked.period.start,
          periodEnd: masked.period.end,
          dueDate: masked.dueDate,
          totalCents: masked.totalCents,
        }).where(eq(invoices.id, invoiceId));

        for (const finding of persistableFindings) {
          const ruleId = ruleIdByRef.get(`${finding.ruleSlug}@${finding.ruleVersion}`);
          if (!ruleId) {
            // `selectApplicableRules` (engine.ts) only ever returns rules
            // present in its own input, so every non-aggregate finding here
            // must trace back to one of the rows `ruleIdByRef` was built
            // from. Reaching this means that invariant broke.
            throw new Error(
              `finding_created for ${finding.ruleSlug}@${finding.ruleVersion} has no matching rules row ` +
              "among the rules loaded for this invoice",
            );
          }
          await tx.insert(findingsTable).values({
            id: newId("fnd"),
            invoiceId,
            itemId: finding.itemId,
            ruleId,
            ruleVersion: finding.ruleVersion,
            confidence: finding.confidence,
            evidence: finding.evidence,
            amountCents: finding.amountCents,
            doubledCents: finding.doubledCents,
            shadow: finding.shadow,
          });
          // The contract `rule-metrics.ts` needs (see its own doc comment):
          // an event missing either `ruleSlug` or `ruleVersion` is silently
          // skipped, not thrown on - this is the exact seam that broke once
          // already between the feedback route and that job (see
          // apps/jobs/test/feedback-metrics-contract.test.ts).
          await recordVia(tx, "finding_created", { ruleSlug: finding.ruleSlug, ruleVersion: finding.ruleVersion });
        }

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
