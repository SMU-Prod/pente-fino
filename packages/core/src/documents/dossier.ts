import type { Category } from "../invoice/canonical.js";
import type { Stage } from "../cases/playbook.js";
import type { ContestDocument } from "./contest.js";
import { maskText } from "../invoice/mask.js";

/**
 * RF-187's dossier — the pure model. When a case reaches `jec_ready`, the
 * person needs one document carrying every fact a Juizado Especial Cível
 * clerk might ask for: every document generated, every protocol registered,
 * every date, plus the list of things to physically attach. This module
 * builds that value from whatever the database holds about the case. It
 * does no I/O, takes no clock (`generatedAt` is an input) and imports
 * nothing outside `packages/core` — a later sub-task renders it to PDF with
 * `pdf-lib` inside `apps/jobs`, and a third loads the rows and runs the job.
 */

export type DossierEntryKind =
  | "case_opened" | "invoice" | "document" | "protocol" | "protocol_response"
  | "deadline" | "stage_change" | "outcome" | "other";

export type DossierEntry = {
  at: Date;
  kind: DossierEntryKind;
  title: string;
  details: string[];
  sourceId: string;
};

export type DossierAttachmentStatus = "available" | "expired" | "user_provided";

export type DossierAttachment = {
  label: string;
  status: DossierAttachmentStatus;
  note?: string;
};

export type DossierParty = {
  role: "consumidor" | "empresa";
  name: string | null;
  document: string | null;
  fields: string[];
};

export type Dossier = {
  caseId: string;
  invoiceId: string;
  generatedAt: Date;
  title: string;
  parties: DossierParty[];
  invoice: {
    issuerName: string;
    category: Category;
    periodStart: string | null;
    periodEnd: string | null;
    dueDate: string | null;
    totalCents: number | null;
    fileAvailable: boolean;
    fileExpiredAt: Date | null;
  };
  contestedItems: Array<{ description: string; amountCents: number; evidence: string[] }>;
  contestedTotalCents: number;
  entries: DossierEntry[];
  attachments: DossierAttachment[];
  notes: string[];
};

export type BuildDossierInput = {
  case: {
    id: string; stage: Stage; createdAt: Date; stageEnteredAt: Date;
    outcome: string | null; closedAt: Date | null;
  };
  issuer: { displayName: string; cnpj: string | null; category: Category };
  invoice: {
    id: string;
    periodStart: string | null; // ISO date as stored ("2026-07-01")
    periodEnd: string | null; // ISO date as stored
    dueDate: string | null; // ISO date as stored
    totalCents: number | null;
    createdAt: Date;
    fileKey: string | null;
  };
  /** Only the items a finding fired on; the caller has already joined. */
  contested: Array<{
    itemId: string | null; description: string | null;
    amountCents: number; evidence: string[];
  }>;
  documents: Array<{
    id: string; stage: Stage; kind: string; createdAt: Date;
    sentAt: Date | null; userEdited: boolean;
    body: ContestDocument; editedBody: ContestDocument | null;
  }>;
  protocols: Array<{
    id: string; stage: Stage; protocolNumber: string; channel: string;
    registeredAt: Date; responseDueAt: Date;
    responseReceivedAt: Date | null; responseSummary: string | null;
  }>;
  events: Array<{
    id: string; type: string; occurredAt: Date; payload: Record<string, unknown>;
  }>;
  generatedAt: Date;
};

// --- pt-BR label tables ----------------------------------------------------

// `Stage` is a closed union (`packages/core/src/cases/playbook.ts`), so this
// table is exhaustively checked by the compiler and needs no fallback —
// unlike the tables below, which key on a column the schema types as a free
// `string`.
const STAGE_LABELS: Record<Stage, string> = {
  draft: "Rascunho",
  sac: "SAC",
  ombudsman: "Ouvidoria",
  consumidor_gov: "consumidor.gov.br",
  regulator: "Órgão regulador",
  procon: "Procon",
  jec_ready: "Pronto para o Juizado Especial Cível",
  closed: "Encerrado",
};

// `case_documents.kind` is a free string in the row this module receives
// (checked at the database boundary, not in this type). A kind this
// module doesn't recognise must still produce a readable line rather than
// `undefined` — hence the fallback in `labelForDocumentKind` below.
const DOCUMENT_KIND_LABELS: Record<string, string> = {
  sac_script: "Roteiro de atendimento (SAC)",
  contest_letter: "Carta de contestação",
  gov_text: "Texto para consumidor.gov.br",
  regulator_text: "Texto para o órgão regulador",
  dossier: "Dossiê",
};

function labelForDocumentKind(kind: string): string {
  return DOCUMENT_KIND_LABELS[kind] ?? `Documento (${kind})`;
}

// `cases.outcome` (RF-186): resolved | partial | denied | abandoned, or
// null while still open or not yet confirmed. Same free-string situation as
// above — a value this table doesn't carry still gets a readable line.
const OUTCOME_LABELS: Record<string, string> = {
  resolved: "Resolvido integralmente",
  partial: "Resolvido parcialmente",
  denied: "Negado pela empresa",
  abandoned: "Encerrado sem resposta da empresa",
};

// Every case-scoped type in the `events.ts` catalogue (the PRD's
// §15.1 list, filtered to the ones a case's own timeline can carry — the
// invoice-ingestion, rule-engine and billing types never reach a
// per-case `events` join and are deliberately absent here), mapped to the
// `DossierEntryKind` closest to what actually happened and a pt-BR title.
// `deadline_expired` / `stage_advanced` / `invoice_file_expired` are the
// three the brief pins down explicitly; the rest follow the same idea.
//
// This table only ever supplies the title for an event that survives the
// drop-matching pass below (`isAnnouncementMatched`) — i.e. one that either
// isn't a pure announcement of an already-rendered row, or is one but
// couldn't be matched to it. A type absent from this table is not an error:
// `buildEventEntries` falls back to `kind: "other"` and a title that quotes
// the raw type, because a parallel task may start emitting a type this
// module was never told about, and losing that entry's date would be worse
// than showing a slightly generic line for it.
const EVENT_META: Record<string, { kind: DossierEntryKind; label: string }> = {
  case_created: { kind: "case_opened", label: "Caso aberto" },
  contest_generated: { kind: "document", label: "Documento de contestação gerado" },
  contest_edited: { kind: "document", label: "Documento de contestação editado" },
  contest_marked_sent: { kind: "document", label: "Documento marcado como enviado" },
  protocol_entered: { kind: "protocol", label: "Protocolo registrado" },
  stage_advanced: { kind: "stage_change", label: "Etapa do caso avançada" },
  deadline_expired: { kind: "deadline", label: "Prazo de resposta esgotado" },
  invoice_file_expired: { kind: "invoice", label: "Arquivo da fatura removido do armazenamento" },
  invoice_file_expiry_failed: { kind: "other", label: "Falha ao remover o arquivo da fatura" },
  diff_run: { kind: "other", label: "Comparação com a fatura seguinte executada" },
  outcome_confirmed: { kind: "outcome", label: "Desfecho do caso confirmado" },
  case_reopened: { kind: "stage_change", label: "Caso reaberto" },
  // RF-187's own job (Task 7, E5 — `apps/jobs`'s dossier task) writes these
  // two types into `events` (see `packages/core/src/events.ts`; not
  // imported here — this table only ever needs the raw string, same as
  // every other entry above). Without an entry, a `dossier_generated` row
  // on a regeneration would fall to the raw-type fallback below instead of
  // a pt-BR label.
  dossier_generated: { kind: "other", label: "Dossiê gerado" },
  dossier_generation_failed: { kind: "other", label: "Falha ao gerar o dossiê" },
};

const DOSSIER_TITLE_SUFFIX = "Dossiê para o Juizado Especial Cível";

const INVOICE_ATTACHMENT_LABEL = "Fatura do período contestado";

const CONSUMER_DATA_NOTE =
  "Os dados do(a) consumidor(a) (nome completo, CPF, endereço e telefone) não são " +
  "mantidos pelo sistema e precisam ser preenchidos manualmente antes de protocolar " +
  "no Juizado Especial Cível.";

// --- date/money formatting --------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * `entries[].at` stays a `Date` — the renderer sub-task formats it for
 * display. This helper exists only for the dates this module itself
 * interpolates into a title or detail *string* (a response deadline, a
 * file-expiry date): `dd/MM/yyyy` built from UTC getters, so it is
 * deterministic and needs no timezone database. A civil date shown to a
 * Brazilian reader is, strictly, a function of their local timezone, not of
 * UTC — reading a UTC instant's date fields can be off by one day right
 * around midnight in some timezones. That is a known simplification this
 * task does not solve; it is confined to this one function.
 */
function formatUtcDate(date: Date): string {
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

// `invoice.periodStart` / `periodEnd` / `dueDate` are stored as plain
// `YYYY-MM-DD` strings with no time component at all (see the type's own
// comment), so there is no instant-to-civil-date conversion to worry about
// here — splitting the string is both simpler and stricter than routing it
// through `Date` and back.
function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  // The DB column is `date`, so in practice this always has exactly three
  // parts — but the value still crosses a boundary TypeScript does not check
  // here (`noUncheckedIndexedAccess` types the destructured parts as
  // `string | undefined`). A malformed value falls back to the raw string
  // rather than silently rendering `undefined/undefined/2026`.
  if (year === undefined || month === undefined || day === undefined) {
    return iso;
  }
  return `${day}/${month}/${year}`;
}

function formatIsoDateOrUnknown(iso: string | null): string {
  return iso !== null ? formatIsoDate(iso) : "não informado";
}

function formatCents(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

// --- timeline: case -----------------------------------------------------

function buildCaseEntries(caseRow: BuildDossierInput["case"]): DossierEntry[] {
  const entries: DossierEntry[] = [
    { at: caseRow.createdAt, kind: "case_opened", title: "Caso aberto", details: [], sourceId: caseRow.id },
  ];

  if (caseRow.closedAt !== null) {
    const outcomeLabel = caseRow.outcome === null
      ? "sem desfecho registrado"
      : (OUTCOME_LABELS[caseRow.outcome] ?? caseRow.outcome);
    entries.push({
      at: caseRow.closedAt,
      kind: "outcome",
      title: `Caso encerrado — ${outcomeLabel}`,
      details: [],
      sourceId: caseRow.id,
    });
  }

  return entries;
}

// --- timeline: invoice ----------------------------------------------------

function buildInvoiceEntry(invoice: BuildDossierInput["invoice"]): DossierEntry {
  const period = `Período: ${formatIsoDateOrUnknown(invoice.periodStart)} a ${formatIsoDateOrUnknown(invoice.periodEnd)}`;
  const due = `Vencimento: ${formatIsoDateOrUnknown(invoice.dueDate)}`;
  const total = `Valor total: ${invoice.totalCents !== null ? formatCents(invoice.totalCents) : "não informado"}`;

  return {
    at: invoice.createdAt,
    kind: "invoice",
    title: "Fatura recebida",
    details: [period, due, total],
    sourceId: invoice.id,
  };
}

// --- timeline: documents ----------------------------------------------------

function buildDocumentEntries(documents: BuildDossierInput["documents"]): DossierEntry[] {
  const entries: DossierEntry[] = [];

  for (const doc of documents) {
    // RF-164: once the person has edited a generated document, the edited
    // version is the one that actually gets used (and, later, sent) — the
    // dossier must describe what happened, not what the model first wrote.
    const body = doc.editedBody ?? doc.body;
    const subject = maskText(body.subject);
    const stageLabel = STAGE_LABELS[doc.stage];
    const kindLabel = labelForDocumentKind(doc.kind);
    const editedLine = doc.userEdited
      ? "Editado pelo usuário antes do uso"
      : "Gerado automaticamente, sem edição do usuário";
    // The dossier previously recorded that a document existed and its
    // subject, but not what was actually asked for — thin for a reader
    // deciding whether the company was given a fair chance to fix this.
    // One masked line per request, beneath the subject.
    const requestLines = body.requests.map((request) => `Pedido: ${maskText(request)}`);

    entries.push({
      at: doc.createdAt,
      kind: "document",
      title: `Documento gerado — ${stageLabel} · ${kindLabel}`,
      details: [`Assunto: ${subject}`, ...requestLines, editedLine],
      sourceId: doc.id,
    });

    if (doc.sentAt !== null) {
      entries.push({
        at: doc.sentAt,
        kind: "document",
        title: `Documento enviado — ${stageLabel} · ${kindLabel}`,
        details: [`Assunto: ${subject}`, ...requestLines],
        sourceId: doc.id,
      });
    }
  }

  return entries;
}

// --- timeline: protocols ----------------------------------------------------

function buildProtocolEntries(protocols: BuildDossierInput["protocols"]): DossierEntry[] {
  const entries: DossierEntry[] = [];

  for (const protocol of protocols) {
    const stageLabel = STAGE_LABELS[protocol.stage];

    // `protocolNumber` and `channel` are structured identifiers, never
    // routed through `maskText` — a protocol number is commonly an
    // 11-digit run, exactly the shape `maskText` looks for when deciding
    // whether something is a CPF.
    entries.push({
      at: protocol.registeredAt,
      kind: "protocol",
      title: `Protocolo registrado — ${protocol.channel}`,
      details: [
        `Número: ${protocol.protocolNumber}`,
        `Etapa: ${stageLabel}`,
        `Prazo de resposta: ${formatUtcDate(protocol.responseDueAt)}`,
      ],
      sourceId: protocol.id,
    });

    if (protocol.responseReceivedAt !== null) {
      entries.push({
        at: protocol.responseReceivedAt,
        kind: "protocol_response",
        title: `Resposta do protocolo recebida — ${protocol.channel}`,
        details: [
          `Número: ${protocol.protocolNumber}`,
          protocol.responseSummary !== null
            ? `Resumo: ${maskText(protocol.responseSummary)}`
            : "Resumo não informado",
        ],
        sourceId: protocol.id,
      });
    }
  }

  return entries;
}

// --- timeline: events ----------------------------------------------------

// A pure announcement of a fact this module already renders from its own
// row (the document, the protocol, the case) would otherwise show up
// twice — once as the real entry, once as the event that announced it. Only
// these five types are ever candidates for dropping; every other type is
// always kept, even if this module has no idea what it means (see
// `EVENT_META`'s doc comment).
const ANNOUNCEMENT_EVENT_TYPES = new Set([
  "contest_generated", "contest_edited", "contest_marked_sent", "protocol_entered", "case_created",
]);

type EventRow = BuildDossierInput["events"][number];

type AnnouncementContext = {
  caseId: string;
  documentIds: Set<string>;
  protocolIds: Set<string>;
  protocolNumbers: Set<string>;
};

/**
 * An event is dropped only when BOTH its type is one of the five above AND
 * its payload can actually be traced to a row this module rendered. An
 * announcement whose payload names nothing recognisable is kept — a
 * parallel task may write a payload shape this module was never told
 * about, and silently losing a date is worse than showing it twice
 * (principle A3: every fact must be reconstructible from what is stored,
 * not guessed).
 */
function isAnnouncementMatched(event: EventRow, ctx: AnnouncementContext): boolean {
  if (!ANNOUNCEMENT_EVENT_TYPES.has(event.type)) return false;
  const payload = event.payload;

  if (event.type === "case_created") {
    return payload.caseId === ctx.caseId || Object.keys(payload).length === 0;
  }

  if (event.type === "protocol_entered") {
    const protocolId = payload.protocolId;
    if (typeof protocolId === "string" && ctx.protocolIds.has(protocolId)) return true;
    const protocolNumber = payload.protocolNumber;
    return typeof protocolNumber === "string" && ctx.protocolNumbers.has(protocolNumber);
  }

  // contest_generated | contest_edited | contest_marked_sent
  const documentId = payload.documentId ?? payload.docId;
  return typeof documentId === "string" && ctx.documentIds.has(documentId);
}

// --- events: best-effort payload enrichment ---------------------------------
//
// A `stage_advanced` event carried nothing about which stages in its
// `details` — the payload holds the substance and the dossier dropped it.
// This is best-effort enrichment of a payload another module writes: E5
// Tasks 3, 4 and 5 are writing these payloads in parallel branches and the
// exact key names were not settled when this module was written, hence the
// generous aliases below. Absence of a recognised key is not an error — an
// event this table cannot enrich still exists in the timeline via its
// title; a key not on this allow-list is NEVER rendered, because an English
// identifier leaking into a pt-BR document is worse than a thin entry. The
// same rule applies to *values*, not only keys: a `stage`-ish or
// `outcome`-ish value that matches a known member of this module's own
// label tables is translated the same way it would be anywhere else in the
// dossier (`STAGE_LABELS` / `OUTCOME_LABELS`); only a value this module
// cannot recognise falls through verbatim — at that point it is data from
// another module, not a label, and inventing a pt-BR translation for it
// would be worse than showing it as-is.

type PayloadPrimitive = string | number | boolean;

function isPayloadPrimitive(value: unknown): value is PayloadPrimitive {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

function isKnownStage(value: string): value is Stage {
  return Object.prototype.hasOwnProperty.call(STAGE_LABELS, value);
}

// Same idea as `isKnownStage`, for the `outcome` payload field: `cases.outcome`
// (RF-186) already has a pt-BR label table declared above, and a payload
// carrying the identical enum value deserves the identical translation, not
// the raw English string.
function isKnownOutcome(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, value);
}

// Strings only, deliberately. A bare number here could be epoch
// milliseconds or epoch seconds — E5 Tasks 3/4/5 have not settled these
// payload shapes, so this module has no way to tell which one a given
// branch meant — and guessing wrong does not fail loudly, it prints a
// confident, wrong date: epoch seconds fed to `new Date(seconds)` renders
// 1970 on a document a person carries into a Juizado. A boolean is never a
// meaningful date either. Both are rejected up front, before `Date` gets a
// chance to coerce either into something misleadingly "valid" (`new
// Date(true)`, `new Date(5)`). A rejected value is not lost — it still
// reaches the page, verbatim, via `renderPayloadValue`'s `String(value)`
// fallback — it is just never mistaken for a parsed date.
function parseDateValue(value: PayloadPrimitive): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MAX_DETAIL_LINE_LENGTH = 200;

function capLine(line: string): string {
  return line.length > MAX_DETAIL_LINE_LENGTH ? `${line.slice(0, MAX_DETAIL_LINE_LENGTH - 1)}…` : line;
}

type PayloadFieldKind = "stage" | "date" | "text" | "outcome";

type PayloadField = { aliases: string[]; label: string; kind: PayloadFieldKind };

// Order here is the order lines are rendered in — deliberately not
// `Object.keys(payload)`, so the output never depends on the order a
// parallel branch happened to write its payload fields in. `fromStage` and
// `toStage` (and their aliases) are kept as two separate fields, not one,
// because a stage transition's whole point is showing *which* stages —
// collapsing them into a single line would silently drop the other end of
// the transition. The bare `stage` field sits between them (not after
// `toStage`) so that a payload carrying both `stage` and `toStage` reads
// forward — "Etapa: X" then "Nova etapa: Y" — instead of announcing the
// destination before the fact that it is one.
const PAYLOAD_FIELDS: PayloadField[] = [
  { aliases: ["fromStage", "previousStage"], label: "Etapa anterior", kind: "stage" },
  { aliases: ["stage"], label: "Etapa", kind: "stage" },
  { aliases: ["toStage", "newStage"], label: "Nova etapa", kind: "stage" },
  { aliases: ["channel"], label: "Canal", kind: "text" },
  { aliases: ["protocolNumber"], label: "Número do protocolo", kind: "text" },
  { aliases: ["deadlineAt", "expiredAt", "dueAt", "at"], label: "Data", kind: "date" },
  { aliases: ["reason"], label: "Motivo", kind: "text" },
  { aliases: ["outcome"], label: "Desfecho", kind: "outcome" },
];

function renderPayloadValue(kind: PayloadFieldKind, value: PayloadPrimitive): string {
  if (kind === "stage" && typeof value === "string" && isKnownStage(value)) {
    return STAGE_LABELS[value];
  }
  if (kind === "outcome" && typeof value === "string" && isKnownOutcome(value)) {
    // `OUTCOME_LABELS` is keyed on a free `string` (RF-186's outcome column
    // isn't a closed union the way `Stage` is), so `noUncheckedIndexedAccess`
    // types this lookup as possibly `undefined` even though `isKnownOutcome`
    // just confirmed the key exists — same situation as
    // `labelForDocumentKind` above. The `?? value` fallback is unreachable
    // in practice; it exists to satisfy the type, not to change behaviour.
    return OUTCOME_LABELS[value] ?? value;
  }
  if (kind === "date") {
    const date = parseDateValue(value);
    if (date !== null) return formatUtcDate(date);
  }
  return String(value);
}

function findPayloadValue(
  payload: Record<string, unknown>,
  aliases: string[],
): { alias: string; value: PayloadPrimitive } | null {
  for (const alias of aliases) {
    const value = payload[alias];
    if (isPayloadPrimitive(value)) return { alias, value };
  }
  return null;
}

/**
 * Renders the allow-listed subset of an event's payload as pt-BR detail
 * lines. A `stage`- or `outcome`-kind value that matches this module's own
 * label tables is translated (`renderPayloadValue`); anything else renders
 * verbatim. Every rendered value is masked with `maskText` — except
 * `protocolNumber`, a structured identifier, same reasoning as everywhere
 * else in this module.
 */
function renderEventPayloadDetails(payload: Record<string, unknown>): string[] {
  const details: string[] = [];

  for (const field of PAYLOAD_FIELDS) {
    const found = findPayloadValue(payload, field.aliases);
    if (found === null) continue;

    const rendered = renderPayloadValue(field.kind, found.value);
    const value = found.alias === "protocolNumber" ? rendered : maskText(rendered);
    details.push(capLine(`${field.label}: ${value}`));
  }

  return details;
}

function buildEventEntries(events: BuildDossierInput["events"], ctx: AnnouncementContext): DossierEntry[] {
  const entries: DossierEntry[] = [];

  for (const event of events) {
    if (isAnnouncementMatched(event, ctx)) continue;

    const meta = EVENT_META[event.type];
    entries.push({
      at: event.occurredAt,
      kind: meta?.kind ?? "other",
      title: meta?.label ?? `Evento do caso: ${event.type}`,
      details: renderEventPayloadDetails(event.payload),
      sourceId: event.id,
    });
  }

  return entries;
}

function latestInvoiceFileExpiredAt(events: BuildDossierInput["events"]): Date | null {
  let latest: Date | null = null;
  for (const event of events) {
    if (event.type !== "invoice_file_expired") continue;
    if (latest === null || event.occurredAt.getTime() > latest.getTime()) {
      latest = event.occurredAt;
    }
  }
  return latest;
}

// --- sorting ----------------------------------------------------------------

// Fixed priority for tie-breaking entries that land on the exact same
// instant. `Array.prototype.sort` in JS is a stable sort, but relying on
// that alone would make the tie-break depend on the *order the caller
// happened to hand rows in* — the order `documents`/`protocols`/`events`
// arrive in, which nothing here controls. Breaking ties on properties of
// the entries themselves (their kind, their source row, their title)
// instead makes the final order depend only on the data, never on how the
// caller assembled its query.
const KIND_ORDER: DossierEntryKind[] = [
  "case_opened", "invoice", "document", "protocol", "protocol_response",
  "deadline", "stage_change", "outcome", "other",
];

function compareEntries(a: DossierEntry, b: DossierEntry): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) return byTime;

  const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (byKind !== 0) return byKind;

  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;

  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  // Unreachable with well-formed input, not merely untested: two entries
  // tie on `at` + `kind` + `sourceId` + `title` only if they came from the
  // same row, and every same-`sourceId` pair this module emits differs in
  // either kind (e.g. protocol vs. protocol_response) or title (e.g.
  // "Documento gerado" vs. "Documento enviado"); ids are primary keys, so
  // no two rows of a table collide. Still required — TypeScript demands a
  // `number` return on every path out of a comparator — and confirmed on
  // re-review as the right call to leave uncovered rather than engineer a
  // synthetic input just to hit it.
  return 0;
}

// --- attachments ----------------------------------------------------------

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function invoiceAttachment(fileAvailable: boolean, fileExpiredAt: Date | null): DossierAttachment {
  if (fileAvailable) {
    return { label: INVOICE_ATTACHMENT_LABEL, status: "available" };
  }

  // RF-110: the file itself may be gone, but `invoices`/`invoice_items`/
  // `findings` survive expiry by design, and `contestedItems` below carries
  // them — this note exists so the dossier neither claims to attach a file
  // it no longer has, nor implies the underlying data went with it.
  const note = fileExpiredAt !== null
    ? `Arquivo removido do armazenamento em ${formatUtcDate(fileExpiredAt)}; os dados da fatura seguem reproduzidos neste dossiê.`
    : "Arquivo não está mais disponível no armazenamento; os dados da fatura seguem reproduzidos neste dossiê.";

  return { label: INVOICE_ATTACHMENT_LABEL, status: "expired", note };
}

function buildAttachments(
  input: BuildDossierInput,
  fileAvailable: boolean,
  fileExpiredAt: Date | null,
): DossierAttachment[] {
  const attachments: DossierAttachment[] = [invoiceAttachment(fileAvailable, fileExpiredAt)];

  for (const protocol of input.protocols) {
    attachments.push({
      label: `Comprovante do protocolo ${protocol.protocolNumber} — ${protocol.channel}, ${formatUtcDate(protocol.registeredAt)}`,
      status: "user_provided",
    });
  }

  // Union, first-seen order, of every document's checklist — de-duplicated
  // case-insensitively after trimming, and skipping anything that repeats
  // entry 1's own label (the invoice is already on the list).
  const seen = new Set<string>([normalizeLabel(INVOICE_ATTACHMENT_LABEL)]);
  for (const doc of input.documents) {
    const body = doc.editedBody ?? doc.body;
    for (const raw of body.attachmentsChecklist) {
      const masked = maskText(raw);
      const key = normalizeLabel(masked);
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push({ label: masked, status: "user_provided" });
    }
  }

  return attachments;
}

// --- main --------------------------------------------------------------

export function buildDossier(input: BuildDossierInput): Dossier {
  const documentIds = new Set(input.documents.map((d) => d.id));
  const protocolIds = new Set(input.protocols.map((p) => p.id));
  const protocolNumbers = new Set(input.protocols.map((p) => p.protocolNumber));

  const entries = [
    ...buildCaseEntries(input.case),
    buildInvoiceEntry(input.invoice),
    ...buildDocumentEntries(input.documents),
    ...buildProtocolEntries(input.protocols),
    ...buildEventEntries(input.events, { caseId: input.case.id, documentIds, protocolIds, protocolNumbers }),
  ].sort(compareEntries);

  const fileAvailable = input.invoice.fileKey !== null;
  const fileExpiredAt = latestInvoiceFileExpiredAt(input.events);

  const contestedItems = input.contested.map((item) => ({
    description: maskText(item.description ?? "Item sem descrição"),
    amountCents: item.amountCents,
    evidence: item.evidence.map(maskText),
  }));
  const contestedTotalCents = contestedItems.reduce((sum, item) => sum + item.amountCents, 0);

  // `users` holds only an email (no name, CPF or address), so this dossier
  // cannot and must not try to qualify the person — the two parties below
  // are the whole story. The consumidor's `fields` name what a human fills
  // in by hand; nothing here ever reads the user's email into the document.
  const parties: DossierParty[] = [
    {
      role: "consumidor",
      name: null,
      document: null,
      fields: ["Nome completo", "CPF", "Endereço completo", "Telefone", "E-mail"],
    },
    {
      // The issuer's CNPJ identifies a company, not a person — the same
      // precedent `maskCanonical`'s own doc comment sets for why it is
      // never routed through `maskText`.
      role: "empresa",
      name: input.issuer.displayName,
      document: input.issuer.cnpj,
      fields: [],
    },
  ];

  const notes: string[] = [CONSUMER_DATA_NOTE];
  if (!fileAvailable) {
    notes.push(
      fileExpiredAt !== null
        ? `A fatura original foi removida do armazenamento em ${formatUtcDate(fileExpiredAt)} (retenção temporária). Os dados extraídos da fatura — período, vencimento, valor e itens contestados — continuam reproduzidos neste dossiê.`
        : "A fatura original não está mais disponível no armazenamento. Os dados extraídos da fatura — período, vencimento, valor e itens contestados — continuam reproduzidos neste dossiê.",
    );
  }

  return {
    caseId: input.case.id,
    invoiceId: input.invoice.id,
    generatedAt: input.generatedAt,
    title: `${DOSSIER_TITLE_SUFFIX} — ${input.issuer.displayName}`,
    parties,
    invoice: {
      issuerName: input.issuer.displayName,
      category: input.issuer.category,
      periodStart: input.invoice.periodStart,
      periodEnd: input.invoice.periodEnd,
      dueDate: input.invoice.dueDate,
      totalCents: input.invoice.totalCents,
      fileAvailable,
      fileExpiredAt,
    },
    contestedItems,
    contestedTotalCents,
    entries,
    attachments: buildAttachments(input, fileAvailable, fileExpiredAt),
    notes,
  };
}
