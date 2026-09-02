import { createHash } from "node:crypto";
import { and, eq, inArray, notExists, or, sql } from "drizzle-orm";
import { buildDossier, maskText, newId } from "@pentefino/core";
import type { BuildDossierInput, EventType } from "@pentefino/core";
import type { Storage } from "@pentefino/core/ports";
import type { TaskHandler } from "@pentefino/adapters";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";
import { renderDossierPdf } from "../pdf/render-dossier.js";
import { resolveNow } from "../clock.js";

const {
  caseDocuments, caseProtocols, cases, events, findings, invoiceItems, invoices, issuers,
} = schema;

export type DossierDeps = {
  db: Database;
  storage: Storage;
};

// Same cap `expire-files.ts` uses (and `ingest.ts` before it, INV-007): a
// failure message here can carry a storage provider's or a PDF library's
// own text, which is not something to trust verbatim into an event payload.
const MAX_FAILURE_MESSAGE_LENGTH = 500;

/**
 * The `events` types that are written against the *invoice* and never
 * against the case, but that still belong on the case's timeline.
 *
 * `invoice_file_expired` is the load-bearing one: `buildDossier` reads it to
 * learn the date RF-110's job deleted the original file, and the dossier
 * then says so instead of claiming to attach a file that no longer exists.
 * That row is written by `expire-files.ts` with an `invoiceId` and no
 * `caseId` at all, so a timeline joined only on `caseId` would silently lose
 * it — and with it the difference between "the invoice is attached" and
 * "the invoice was deleted on 15/07/2026, here is its data anyway".
 * `invoice_file_expiry_failed` is its sibling, written the same way by the
 * same job, and belongs here for the same reason: it is the record of why a
 * file that should be gone is not.
 * `invoice_uploaded` and `invoice_analyzed` are on the list for the plainer
 * reason that a case's story starts before the case row does.
 *
 * Every type named here needs an `EVENT_META` entry in
 * `packages/core/src/documents/dossier.ts`. Without one it falls to that
 * module's raw-type fallback and prints its own English identifier —
 * `Evento do caso: invoice_uploaded` — on a document a judge reads.
 */
const INVOICE_SCOPED_EVENT_TYPES: string[] = [
  "invoice_uploaded", "invoice_analyzed", "invoice_file_expired", "invoice_file_expiry_failed",
];

type CaseRow = typeof cases.$inferSelect;

/**
 * RF-187's job: every case that has reached `jec_ready` and does not yet
 * have a dossier gets one — a chronological PDF carrying every document,
 * every protocol and every date, plus the list of things to attach.
 *
 * Eligibility, and idempotency with it (A4), is the absence of a
 * `dossier_generated` event for the case. That is the same shape
 * `expire-files.ts` uses `fileKey IS NOT NULL` for: the guard is a fact
 * already stored for its own reasons, not a second bookkeeping column that
 * could drift from it. Once a case has its event, every later run excludes
 * it in the query itself — no second PDF, no second event, no read of the
 * case's rows at all.
 *
 * That is sequential idempotency, and it is the only kind this guard buys.
 * `notExists` is a filter, not a lock, and `events` has no uniqueness on
 * `(case_id, type)`: two runs overlapping in time can both select the same
 * case before either has recorded its event, and both then write a
 * `dossier_generated` row and store a second PDF. Closing that window means
 * a partial unique index on `events (case_id) WHERE type =
 * 'dossier_generated'` — a schema change, and three other E5 tasks are in
 * flight against this table — so the window is named here rather than
 * silently implied away. Nothing enqueues this job concurrently today.
 *
 * Error isolation (A8) follows `expire-files.ts` exactly: one case's failure
 * (a storage outage, an unreadable row, a renderer that throws) must not
 * sink the run for every other case, so each case's work sits in its own
 * try/catch. A failure records a `dossier_generation_failed` event with a
 * masked, length-capped message and the loop continues; no
 * `dossier_generated` is written, so the next run picks that case up again.
 * One qualification, the same one `expire-files.ts` carries: the
 * `dossier_generation_failed` insert is itself in the catch block, so if
 * *that* write throws, the run aborts and the remaining cases are skipped
 * until the next one. Isolation covers a case's own work, not the database
 * being unreachable.
 *
 * Where the bytes land, said plainly rather than left to be discovered:
 * the `Storage` port's only key-minting path today is the upload flow
 * (`signUpload` then `put`), so a *generated* artifact ends up in the
 * `uploads/<owner>/` namespace alongside the files people uploaded
 * themselves. Three other E5 tasks are in flight against this port, so
 * widening it is not this task's change to make — but a dedicated
 * `dossiers/` namespace (or a `putGenerated` that mints its own key) is the
 * right follow-up. A second consequence of the same shape: `expire-files.ts`
 * deletes only what `invoices.fileKey` points at, so this object has no
 * retention rule of its own and will sit in storage indefinitely. Both are
 * known, neither is silent.
 */
export function createDossierTask(deps: DossierDeps): TaskHandler {
  const { db, storage } = deps;

  async function record(caseRow: CaseRow, type: EventType, payload: Record<string, unknown>) {
    await db.insert(events).values({
      id: newId("evt"), caseId: caseRow.id, invoiceId: caseRow.invoiceId, userId: caseRow.userId,
      type, payload,
    });
  }

  /**
   * Assembles `buildDossier`'s input from the rows. Anything missing that
   * the model requires (the issuer, the invoice) throws rather than being
   * papered over with a placeholder: a dossier is a court document, and one
   * naming no company is worse than one that was not produced and gets
   * retried on the next run.
   */
  async function loadInput(caseRow: CaseRow, now: Date): Promise<BuildDossierInput> {
    const [issuer] = await db
      .select({ displayName: issuers.displayName, cnpj: issuers.cnpj, category: issuers.category })
      .from(issuers)
      .where(eq(issuers.id, caseRow.issuerId));
    if (!issuer) throw new Error(`case ${caseRow.id} points at a missing issuer ${caseRow.issuerId}`);

    const [invoice] = await db
      .select({
        id: invoices.id, periodStart: invoices.periodStart, periodEnd: invoices.periodEnd,
        dueDate: invoices.dueDate, totalCents: invoices.totalCents,
        createdAt: invoices.createdAt, fileKey: invoices.fileKey,
      })
      .from(invoices)
      .where(eq(invoices.id, caseRow.invoiceId));
    if (!invoice) throw new Error(`case ${caseRow.id} points at a missing invoice ${caseRow.invoiceId}`);

    // `findingIds` is a jsonb array on the case, so the invoice a finding
    // actually belongs to is NOT implied by it — an id from a different
    // invoice (a stale copy, a bad write, a hostile edit of the array)
    // would otherwise put another invoice's charge into this invoice's
    // court document. The `invoiceId` equality is what makes that
    // impossible; `inArray` alone is not enough. An empty array skips the
    // query entirely rather than relying on how the driver renders
    // `IN ()`.
    const contested = caseRow.findingIds.length === 0 ? [] : await db
      .select({
        itemId: findings.itemId,
        description: invoiceItems.description,
        amountCents: findings.amountCents,
        evidence: findings.evidence,
      })
      .from(findings)
      .leftJoin(invoiceItems, eq(findings.itemId, invoiceItems.id))
      .where(and(
        inArray(findings.id, caseRow.findingIds),
        eq(findings.invoiceId, caseRow.invoiceId),
      ))
      .orderBy(findings.createdAt, findings.id);

    const documents = await db
      .select({
        id: caseDocuments.id, stage: caseDocuments.stage, kind: caseDocuments.kind,
        createdAt: caseDocuments.createdAt, sentAt: caseDocuments.sentAt,
        userEdited: caseDocuments.userEdited, body: caseDocuments.body, editedBody: caseDocuments.editedBody,
      })
      .from(caseDocuments)
      .where(eq(caseDocuments.caseId, caseRow.id))
      .orderBy(caseDocuments.createdAt, caseDocuments.id);

    const protocols = await db
      .select({
        id: caseProtocols.id, stage: caseProtocols.stage, protocolNumber: caseProtocols.protocolNumber,
        channel: caseProtocols.channel, registeredAt: caseProtocols.registeredAt,
        responseDueAt: caseProtocols.responseDueAt, responseReceivedAt: caseProtocols.responseReceivedAt,
        responseSummary: caseProtocols.responseSummary,
      })
      .from(caseProtocols)
      .where(eq(caseProtocols.caseId, caseRow.id))
      .orderBy(caseProtocols.registeredAt, caseProtocols.id);

    const timeline = await db
      .select({ id: events.id, type: events.type, occurredAt: events.occurredAt, payload: events.payload })
      .from(events)
      .where(or(
        eq(events.caseId, caseRow.id),
        and(eq(events.invoiceId, caseRow.invoiceId), inArray(events.type, INVOICE_SCOPED_EVENT_TYPES)),
      ))
      .orderBy(events.occurredAt, events.id);

    return {
      // `stage`/`stageEnteredAt` are deliberately not passed: `buildDossier`
      // does not take them (see `BuildDossierInput`'s own comment on why the
      // timeline already carries the case's stage history, with dates).
      case: {
        id: caseRow.id, createdAt: caseRow.createdAt,
        outcome: caseRow.outcome, closedAt: caseRow.closedAt,
      },
      issuer,
      invoice,
      contested,
      documents,
      protocols,
      events: timeline,
      generatedAt: now,
    };
  }

  /**
   * The local adapter's `put` refuses a fileKey with no signed upload, and
   * then re-derives the hash, checks the length and sniffs the leading bytes
   * against the declared type — so the hash has to be over exactly these
   * bytes, and the declared type has to be what they actually are.
   * `pdf-lib`'s output starts with `%PDF`, which `sniffMimeType` reads as
   * `application/pdf`.
   */
  async function store(owner: string, bytes: Uint8Array): Promise<string> {
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const { fileKey } = await storage.signUpload({
      owner, contentHash, mimeType: "application/pdf", sizeBytes: bytes.length,
    });
    await storage.put(fileKey, bytes);
    return fileKey;
  }

  return async function dossier(payload: Record<string, unknown>): Promise<void> {
    const now = resolveNow(payload, "dossier");

    // `notExists` rather than loading every jec_ready case and filtering in
    // memory: the guard belongs in the query, so a case that already has its
    // dossier is never even read. It is a filter, not a lock — see the
    // concurrency paragraph on `createDossierTask` for the window that
    // leaves open, and what closing it would take.
    const eligible = await db
      .select()
      .from(cases)
      .where(and(
        eq(cases.stage, "jec_ready"),
        notExists(
          db.select({ present: sql<number>`1` })
            .from(events)
            .where(and(eq(events.caseId, cases.id), eq(events.type, "dossier_generated"))),
        ),
      ))
      // Only so a run's order is a property of the data rather than of
      // whatever order the planner returns rows in — which matters the
      // moment one case fails and the operator has to reason about what the
      // run did before and after it.
      .orderBy(cases.createdAt, cases.id);

    for (const caseRow of eligible) {
      try {
        const input = await loadInput(caseRow, now);
        const built = buildDossier(input);
        const bytes = await renderDossierPdf(built);
        const fileKey = await store(caseRow.userId, bytes);

        // One statement, so this transaction is not buying atomicity the
        // insert would not already have. It is here because this row is the
        // idempotency guard: anything a later task adds alongside it (a
        // column on `cases` pointing at the dossier, say) has to land with
        // it or not at all, and the boundary being already drawn is what
        // makes that a one-line change instead of a correctness question.
        await db.transaction(async (tx) => {
          await tx.insert(events).values({
            id: newId("evt"), caseId: caseRow.id, invoiceId: caseRow.invoiceId, userId: caseRow.userId,
            type: "dossier_generated",
            payload: {
              fileKey,
              sizeBytes: bytes.length,
              entryCount: built.entries.length,
              attachmentCount: built.attachments.length,
              invoiceFileAvailable: built.invoice.fileAvailable,
            },
          });
        });
      } catch (error) {
        const message = maskText(error instanceof Error ? error.message : String(error))
          .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
        // No `dossier_generated` for this case, so the next run finds it
        // eligible again and retries it.
        await record(caseRow, "dossier_generation_failed", { message });
      }
    }
  };
}
