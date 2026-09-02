// RF-187: renders a `Dossier` (the pure model `buildDossier` builds in
// `packages/core`) to PDF bytes. This module lives in `apps/jobs`, a
// Node-only job package, and `pdf-lib` is a dependency of `apps/jobs`
// alone — never of `apps/web`.
//
// `apps/web` does depend on `@pentefino/jobs` — `lib/container.ts` and the
// API route handlers import it, all server-side. What the package's barrel
// (`src/index.ts`) exposes therefore matters, and this module is
// deliberately not on it: `renderDossierPdf`'s only production consumer is
// `tasks/dossier.ts`, which imports it relatively, so `pdf-lib` is not
// reachable from web code through the barrel at all. That is a structural
// property now, not a "nobody has done it yet" one.
//
// Why it is worth being structural — the asymmetry: the barrel already
// pulls `@pentefino/db` -> `postgres`, a Node-only driver that would break a
// browser build loudly. `pdf-lib` is browser-compatible pure JS, so an
// accidental client-side import would bundle ~350 kB silently instead of
// failing. The gate that would actually catch that is
// `scripts/check-bundle-budget.mjs`, run in CI against `next build`'s own
// First Load JS table — i.e. against RNF-05's <=120 kB gzip budget measured
// on the number that really ships, not on a proxy for it.
//
// So: never import this module, or `pdf-lib`, from a client component.
import { PDFDocument, PageSizes, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import { formatCentsBRL, formatIsoDateOrUnknown, formatUtcDate } from "@pentefino/core";
import type {
  Category, Dossier, DossierAttachmentStatus, DossierParty,
} from "@pentefino/core";

// --- geometry ---------------------------------------------------------------

const [PAGE_WIDTH, PAGE_HEIGHT] = PageSizes.A4;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const INDENT_STEP = 16;
const FOOTER_Y = 30;

const TITLE_SIZE = 18;
const TITLE_LINE_HEIGHT = 24;
const HEADING_SIZE = 13;
const HEADING_LINE_HEIGHT = 18;
const BODY_SIZE = 10;
const BODY_LINE_HEIGHT = 14;
const FOOTER_SIZE = 8;

// Gap inserted before every section heading except the very first thing on
// the page. A heading landing right at the bottom of a page and pushing
// straight to a new page is ugly but explicitly not a defect (brief,
// "Pagination") — so this is a plain subtraction, not a "keep heading with
// its first line" reservation.
const SECTION_GAP = 10;

const GREY = rgb(0.45, 0.45, 0.45);
const BLACK = rgb(0, 0, 0);

// Baseline sits a fixed fraction below the top of each line's box. This is
// a layout approximation, not a font-metrics computation from ascent/
// descent — good enough for a body of running text at fixed sizes, and
// nothing here is asserted pixel-for-pixel (the tests read the PDF back as
// text, not as coordinates).
const BASELINE_RATIO = 0.8;

// --- pt-BR label tables (rendering-only; §14.3 vocabulary applies) --------

const PARTY_ROLE_LABELS: Record<DossierParty["role"], string> = {
  consumidor: "Consumidor",
  empresa: "Empresa",
};

const ATTACHMENT_STATUS_LABELS: Record<DossierAttachmentStatus, string> = {
  available: "disponível no sistema",
  expired: "não está mais disponível no sistema",
  user_provided: "a providenciar",
};

// Category (packages/core/src/invoice/canonical.ts) is a closed union of
// four English tokens used internally as a database enum. "Every string
// drawn on the page is pt-BR" (house rule) applies to it like anything
// else the invoice section shows.
const CATEGORY_LABELS: Record<Category, string> = {
  telecom: "Telecomunicações",
  card: "Cartão de crédito",
  energy: "Energia elétrica",
  water: "Água",
};

const SECTION_HEADINGS = {
  parties: "Qualificação das partes",
  invoice: "A fatura",
  contested: "Itens contestados",
  timeline: "Linha do tempo",
  attachments: "Lista de anexos",
  notes: "Observações",
} as const;

// The three mutually exclusive things this renderer can say about the
// original invoice file (RF-110). Named rather than inline so
// `RENDERER_FIXED_STRINGS` can collect them: the third is reachable only
// when the file is gone AND no `invoice_file_expired` event recorded when,
// which no realistic fixture produces.
const FILE_AVAILABLE_LINE = "Arquivo original da fatura: disponível no sistema.";
const FILE_REMOVED_UNDATED_LINE = "Arquivo original da fatura: removido do armazenamento (data não registrada).";

function fileRemovedLine(at: Date): string {
  return `Arquivo original da fatura: removido do armazenamento em ${formatUtcDate(at)}.`;
}

// Checkbox-ish markers for the attachment list: what the system already
// holds is ticked, everything the person still has to bring is not.
const ATTACHMENT_MARKER_HELD = "[x]";
const ATTACHMENT_MARKER_TO_BRING = "[ ]";

const NO_VALUE_LABEL = "não informado";

/**
 * Every fixed pt-BR string this renderer adds on its own, flattened for the
 * INV-004/INV-005 vocabulary suite to lint one by one. The counterpart of
 * `@pentefino/core`'s `DOSSIER_FIXED_STRINGS`, and for the same reason:
 * several of these (three of the four category labels, the undated
 * file-removal wording) cannot be reached by any one rendered fixture, so
 * driving them through a document was never going to gate them. Derived
 * from the tables above, never re-typed.
 *
 * The label prefixes this module interpolates values into — `Prestadora:`,
 * `Vencimento:`, `Total contestado:`, `Página X de Y` and the rest — are
 * on every dossier it produces, so the suite's two rendered fixtures gate
 * those end-to-end and they are deliberately not repeated here.
 */
export const RENDERER_FIXED_STRINGS: readonly string[] = [
  ...Object.values(SECTION_HEADINGS),
  ...Object.values(PARTY_ROLE_LABELS),
  ...Object.values(ATTACHMENT_STATUS_LABELS),
  ...Object.values(CATEGORY_LABELS),
  FILE_AVAILABLE_LINE,
  FILE_REMOVED_UNDATED_LINE,
  fileRemovedLine(new Date(0)),
  ATTACHMENT_MARKER_HELD,
  ATTACHMENT_MARKER_TO_BRING,
  NO_VALUE_LABEL,
];

// --- date/money formatting ---------------------------------------------------
//
// `formatCentsBRL`, `formatUtcDate` and `formatIsoDateOrUnknown` are
// imported from `@pentefino/core` above rather than re-implemented here.
// This module used to carry private copies of all three, and they did not
// agree with the ones `buildDossier` uses for the strings it hands over:
// the invoice total is printed twice on the same page, once from each, so
// a total of 118 990 cents came out as `R$ 1.189,90` in the invoice section
// and `R$ 1189,90` in the timeline, and a credit as `-R$ 1,50` and
// `R$ -1,50`. The date copy had drifted the other way — it lacked the
// malformed-input guard and would print `undefined/undefined/2026`. One
// implementation, in the package that already owns the model, is the only
// arrangement in which those cannot diverge again.

// --- WinAnsi sanitization ----------------------------------------------------

// Characters with an obvious WinAnsi-safe equivalent are normalized even
// though some of them (the dashes) already encode fine — this keeps the
// document's punctuation consistent regardless of what a phone keyboard's
// "smart quotes" or a pasted ellipsis happened to produce. `– —` are
// themselves valid WinAnsi codepoints (verified against the embedded
// Helvetica font before writing this) and are deliberately left alone.
//
// The NBSP entry is close to dead code: on the main text-wrapping path
// `splitWords`'s `text.split(/\s+/)` matches NBSP as whitespace and
// consumes it as a word separator before `sanitizeWord` (and this table)
// ever runs, and NBSP (0xA0) is WinAnsi-encodable on its own anyway, so it
// was never a crash risk. It only has any effect at all when `sanitizeWord`
// is called on a whole caller-owned string that skips `splitWords`
// (`formLine`'s label, `drawLabelWithRightValue`'s value) — and even there
// it is a no-op today since none of those strings carry an NBSP. Kept for
// the case where they eventually do, since the fix is free.
const KNOWN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/…/g, "..."],
  [/ /g, " "],
];

function normalizeKnownChars(text: string): string {
  return KNOWN_REPLACEMENTS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/**
 * pdf-lib's standard-14 fonts throw the moment `drawText` (via
 * `widthOfTextAtSize`/`encodeText`) is asked to place a character outside
 * WinAnsiEncoding — and this renderer draws text that ultimately traces
 * back to `case_documents.editedBody`, i.e. something a person typed and
 * could easily paste an emoji, a `→`, or a CJK character into. A stray
 * character must never be the reason a person's court dossier fails to be
 * produced (INV-*: a document must degrade, never crash).
 *
 * Detection asks the embedded font itself rather than hand-maintaining a
 * WinAnsi character table that could drift from whatever pdf-lib's
 * embedder actually supports: `widthOfTextAtSize` throws on exactly the
 * codepoints `encodeText` cannot map, so probing one codepoint at a time is
 * ground truth, not a guess. Iterating with `for...of` walks Unicode code
 * points rather than UTF-16 code units, so a surrogate-pair emoji collapses
 * to a single `?` instead of two mangled halves.
 *
 * Receives either a whitespace-free word from `splitWords`, or a short
 * caller-owned string whose only whitespace is plain spaces (`formLine`'s
 * field label, `drawLabelWithRightValue`'s formatted money value — both
 * call this directly on a whole string, not per word). Plain space (0x20)
 * is WinAnsi-encodable, so that is harmless today. Tab and newline are not
 * WinAnsi-encodable and would be replaced with `?` here rather than
 * wrapped; `splitWords` consumes them as separators before that can happen
 * on the main text-wrapping path, but a caller that hands this function a
 * whole string bypasses that — a `\n` arriving through `party.fields`
 * would silently become `?` instead of starting a new line.
 */
function sanitizeWord(font: PDFFont, word: string): string {
  const normalized = normalizeKnownChars(word);
  let result = "";
  for (const char of normalized) {
    try {
      font.widthOfTextAtSize(char, 1);
      result += char;
    } catch {
      result += "?";
    }
  }
  return result;
}

function splitWords(font: PDFFont, text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0).map((w) => sanitizeWord(font, w));
}

// --- text wrapping ------------------------------------------------------

/**
 * A single sanitized word wider than `maxWidth` on its own (a long URL, a
 * raw id) must not overflow the margin or be handed to `drawText` as one
 * unbreakable line — hard-split it by character. `current === ""` guards
 * the pathological case where even one character is wider than
 * `maxWidth`: that character still becomes its own line rather than
 * looping forever trying to shrink below one character.
 */
function hardSplitWord(font: PDFFont, word: string, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const char of word) {
    const candidate = current + char;
    if (current === "" || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      pieces.push(current);
      current = char;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** Greedy word-wrap over already-sanitized words. Never drops a word. */
function wrapWords(font: PDFFont, words: string[], size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current !== "") lines.push(current);

    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      const pieces = hardSplitWord(font, word, size, maxWidth);
      for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]!);
      current = pieces[pieces.length - 1] ?? "";
    } else {
      current = word;
    }
  }
  if (current !== "") lines.push(current);

  return lines;
}

// `splitWords` collapses every whitespace run to a single space, embedded
// newlines included — so any paragraph structure inside a `details` string
// coming from `case_documents.editedBody` does not survive into the PDF.
// Reasonable for this document (a chronology of short facts, not a reflow
// of freeform prose), and it is what lets the test suite's own
// `normalizeWhitespace` compare wrapped output against a single-line
// needle.
function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  return wrapWords(font, splitWords(font, text), size, maxWidth);
}

// --- page/cursor builder -------------------------------------------------

type TextStyle = { font: PDFFont; size: number; indent?: number; color?: typeof BLACK };

/**
 * Owns pagination. `y` tracks the top of the next line's box on the
 * current page; `nextBaseline` is the only place that decides whether the
 * current page still has room, and it is the single choke point every
 * drawing helper below goes through — so "start a new page when a line
 * would cross the bottom margin" only has to be correct once. Page numbers
 * are written in a final pass after every page already exists (`drawFooters`),
 * never while drawing content — the whole point being that `Página X de Y`
 * needs an actual, final Y.
 */
class PageBuilder {
  readonly pages: PDFPage[] = [];
  private page: PDFPage;
  private y = 0;

  constructor(private readonly doc: PDFDocument) {
    this.page = this.newPage();
  }

  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    this.page = page;
    this.y = PAGE_HEIGHT - MARGIN;
    return page;
  }

  private nextBaseline(lineHeight: number): { page: PDFPage; baseline: number } {
    if (this.y - lineHeight < MARGIN) this.newPage();
    const baseline = this.y - lineHeight * BASELINE_RATIO;
    this.y -= lineHeight;
    return { page: this.page, baseline };
  }

  /** Vertical whitespace with no page-break protection — see SECTION_GAP's comment. */
  spacer(amount: number): void {
    this.y -= amount;
  }

  /** Draws one line that the caller already knows fits within its column. */
  drawLine(text: string, style: TextStyle, lineHeight: number): void {
    const { page, baseline } = this.nextBaseline(lineHeight);
    page.drawText(text, {
      x: MARGIN + (style.indent ?? 0),
      y: baseline,
      size: style.size,
      font: style.font,
      color: style.color ?? BLACK,
    });
  }

  /** Wraps `text` to the column width at `style.indent` and draws every resulting line. */
  drawWrapped(text: string, style: TextStyle, lineHeight: number): void {
    const indent = style.indent ?? 0;
    const lines = wrapText(style.font, text, style.size, CONTENT_WIDTH - indent);
    for (const line of lines) this.drawLine(line, style, lineHeight);
  }

  /**
   * A label/value line whose value is right-aligned to the page's content
   * edge (used for a contested item's amount). Only the line the value
   * lands on carries it — if the label wraps to further lines, those are
   * label-only, exactly like the rest of a wrapped paragraph.
   */
  drawLabelWithRightValue(label: string, value: string, style: TextStyle, lineHeight: number): void {
    const indent = style.indent ?? 0;
    // value is our own formatted text (money, in practice) - plain spaces only, safe to sanitize as one unit.
    const sanitizedValue = sanitizeWord(style.font, value);
    const valueWidth = style.font.widthOfTextAtSize(sanitizedValue, style.size);
    const gap = 12;
    const available = CONTENT_WIDTH - indent - valueWidth - gap;
    // `value` is always a short formatted money string here, so `available`
    // realistically never drops below this floor — it exists only so a
    // pathological caller can never end up wrapping the label into a
    // negative-width column.
    const MIN_LABEL_COLUMN = 40;
    const lines = wrapText(style.font, label, style.size, Math.max(available, MIN_LABEL_COLUMN));

    lines.forEach((line, i) => {
      const { page, baseline } = this.nextBaseline(lineHeight);
      page.drawText(line, { x: MARGIN + indent, y: baseline, size: style.size, font: style.font, color: style.color ?? BLACK });
      if (i === 0) {
        const valueX = MARGIN + CONTENT_WIDTH - valueWidth;
        page.drawText(sanitizedValue, { x: valueX, y: baseline, size: style.size, font: style.font, color: style.color ?? BLACK });
      }
    });
  }
}

// --- section rendering ----------------------------------------------------

function drawHeading(builder: PageBuilder, bold: PDFFont, text: string): void {
  builder.spacer(SECTION_GAP);
  builder.drawWrapped(text, { font: bold, size: HEADING_SIZE }, HEADING_LINE_HEIGHT);
}

function drawTitleBlock(builder: PageBuilder, fonts: { regular: PDFFont; bold: PDFFont }, dossier: Dossier): void {
  builder.drawWrapped(dossier.title, { font: fonts.bold, size: TITLE_SIZE }, TITLE_LINE_HEIGHT);
  builder.drawWrapped(`Caso ${dossier.caseId}`, { font: fonts.regular, size: BODY_SIZE }, BODY_LINE_HEIGHT);
  builder.drawWrapped(`Fatura ${dossier.invoiceId}`, { font: fonts.regular, size: BODY_SIZE }, BODY_LINE_HEIGHT);
  builder.drawWrapped(
    `Documento gerado em ${formatUtcDate(dossier.generatedAt)}`,
    { font: fonts.regular, size: BODY_SIZE },
    BODY_LINE_HEIGHT,
  );
}

/**
 * A form line for a field the system doesn't hold: the label, then a rule
 * of underscores sized to fill the rest of the available width, so it
 * reads as a line to complete by hand rather than a blank or an empty
 * string (that visible blankness is the entire point of this block).
 * `Math.max(3, ...)` keeps the rule non-empty even for a label so long it
 * would otherwise overrun the column — a defensive floor, not something
 * any of this module's real field labels come close to needing.
 */
function formLine(font: PDFFont, label: string, size: number, availableWidth: number): string {
  // label comes from party.fields, i.e. buildDossier's own fixed pt-BR
  // field names - short, single-line, plain spaces only, so it is safe to
  // sanitize as one unit rather than routing it through splitWords.
  const prefix = `${sanitizeWord(font, label)}: `;
  const prefixWidth = font.widthOfTextAtSize(prefix, size);
  const underscoreWidth = font.widthOfTextAtSize("_", size);
  const count = Math.max(3, Math.floor((availableWidth - prefixWidth) / underscoreWidth));
  return prefix + "_".repeat(count);
}

function drawParties(builder: PageBuilder, fonts: { regular: PDFFont; bold: PDFFont }, dossier: Dossier): void {
  drawHeading(builder, fonts.bold, SECTION_HEADINGS.parties);

  for (const party of dossier.parties) {
    builder.drawWrapped(PARTY_ROLE_LABELS[party.role], { font: fonts.bold, size: BODY_SIZE }, BODY_LINE_HEIGHT);

    if (party.name === null) {
      // `party.document` is never printed in this branch — the type
      // permits a null name with a non-null document, but `buildDossier`
      // never produces that combination today (the only null-name party is
      // the consumidor, whose document is also always null). If a future
      // caller ever does hand this a document alongside a null name, it
      // would silently be dropped; worth a line here rather than a comment
      // at buildDossier's call site, since this is the code that drops it.
      for (const field of party.fields) {
        const line = formLine(fonts.regular, field, BODY_SIZE, CONTENT_WIDTH - INDENT_STEP);
        builder.drawLine(line, { font: fonts.regular, size: BODY_SIZE, indent: INDENT_STEP }, BODY_LINE_HEIGHT);
      }
      continue;
    }

    builder.drawWrapped(`Nome: ${party.name}`, { font: fonts.regular, size: BODY_SIZE, indent: INDENT_STEP }, BODY_LINE_HEIGHT);
    if (party.document !== null) {
      builder.drawWrapped(
        `Documento: ${party.document}`,
        { font: fonts.regular, size: BODY_SIZE, indent: INDENT_STEP },
        BODY_LINE_HEIGHT,
      );
    }
  }
}

function invoiceFileLine(invoice: Dossier["invoice"]): string {
  if (invoice.fileAvailable) return FILE_AVAILABLE_LINE;
  if (invoice.fileExpiredAt !== null) return fileRemovedLine(invoice.fileExpiredAt);
  return FILE_REMOVED_UNDATED_LINE;
}

function drawInvoiceSection(builder: PageBuilder, fonts: { regular: PDFFont; bold: PDFFont }, dossier: Dossier): void {
  drawHeading(builder, fonts.bold, SECTION_HEADINGS.invoice);
  const { invoice } = dossier;
  const style = { font: fonts.regular, size: BODY_SIZE };

  builder.drawWrapped(`Prestadora: ${invoice.issuerName}`, style, BODY_LINE_HEIGHT);
  builder.drawWrapped(`Categoria: ${CATEGORY_LABELS[invoice.category]}`, style, BODY_LINE_HEIGHT);
  builder.drawWrapped(
    `Período: ${formatIsoDateOrUnknown(invoice.periodStart)} a ${formatIsoDateOrUnknown(invoice.periodEnd)}`,
    style,
    BODY_LINE_HEIGHT,
  );
  builder.drawWrapped(`Vencimento: ${formatIsoDateOrUnknown(invoice.dueDate)}`, style, BODY_LINE_HEIGHT);
  builder.drawWrapped(
    `Valor total: ${invoice.totalCents !== null ? formatCentsBRL(invoice.totalCents) : NO_VALUE_LABEL}`,
    style,
    BODY_LINE_HEIGHT,
  );
  builder.drawWrapped(invoiceFileLine(invoice), style, BODY_LINE_HEIGHT);
}

function drawContestedItems(builder: PageBuilder, fonts: { regular: PDFFont; bold: PDFFont }, dossier: Dossier): void {
  drawHeading(builder, fonts.bold, SECTION_HEADINGS.contested);

  for (const item of dossier.contestedItems) {
    builder.drawLabelWithRightValue(
      item.description,
      formatCentsBRL(item.amountCents),
      { font: fonts.regular, size: BODY_SIZE },
      BODY_LINE_HEIGHT,
    );
    for (const evidence of item.evidence) {
      builder.drawWrapped(
        `- ${evidence}`,
        { font: fonts.regular, size: BODY_SIZE, indent: INDENT_STEP },
        BODY_LINE_HEIGHT,
      );
    }
  }

  builder.drawWrapped(
    `Total contestado: ${formatCentsBRL(dossier.contestedTotalCents)}`,
    { font: fonts.bold, size: BODY_SIZE },
    BODY_LINE_HEIGHT,
  );
}

function drawTimeline(builder: PageBuilder, fonts: { regular: PDFFont; bold: PDFFont }, dossier: Dossier): void {
  drawHeading(builder, fonts.bold, SECTION_HEADINGS.timeline);

  // Rendered strictly in array order — `dossier.entries` arrives already
  // chronological (sub-task A's own sort, with a deterministic tie-break);
  // re-sorting here would be both redundant and a second place the order
  // could drift from what the model actually decided.
  for (const item of dossier.entries) {
    builder.drawWrapped(
      `${formatUtcDate(item.at)} — ${item.title}`,
      { font: fonts.bold, size: BODY_SIZE },
      BODY_LINE_HEIGHT,
    );
    for (const line of item.details) {
      builder.drawWrapped(
        `- ${line}`,
        { font: fonts.regular, size: BODY_SIZE, indent: INDENT_STEP },
        BODY_LINE_HEIGHT,
      );
    }
  }
}

function attachmentMarker(status: DossierAttachmentStatus): string {
  return status === "available" ? ATTACHMENT_MARKER_HELD : ATTACHMENT_MARKER_TO_BRING;
}

function drawAttachments(builder: PageBuilder, fonts: { regular: PDFFont; bold: PDFFont }, dossier: Dossier): void {
  drawHeading(builder, fonts.bold, SECTION_HEADINGS.attachments);

  for (const attachment of dossier.attachments) {
    builder.drawWrapped(
      `${attachmentMarker(attachment.status)} ${attachment.label} — ${ATTACHMENT_STATUS_LABELS[attachment.status]}`,
      { font: fonts.regular, size: BODY_SIZE },
      BODY_LINE_HEIGHT,
    );
    if (attachment.note !== undefined) {
      builder.drawWrapped(
        attachment.note,
        { font: fonts.regular, size: BODY_SIZE, indent: INDENT_STEP },
        BODY_LINE_HEIGHT,
      );
    }
  }
}

function drawNotes(builder: PageBuilder, fonts: { regular: PDFFont; bold: PDFFont }, dossier: Dossier): void {
  if (dossier.notes.length === 0) return; // brief: omit the whole section when there are none

  drawHeading(builder, fonts.bold, SECTION_HEADINGS.notes);
  for (const note of dossier.notes) {
    builder.drawWrapped(note, { font: fonts.regular, size: BODY_SIZE }, BODY_LINE_HEIGHT);
    builder.spacer(4);
  }
}

/**
 * Runs only after every page already exists, so `Página X de Y` can carry
 * a real, final `Y` — writing page numbers while content is still being
 * laid out would mean guessing `Y` before it is known.
 */
function drawFooters(pages: PDFPage[], font: PDFFont, caseId: string): void {
  const total = pages.length;
  // Every other drawn string on the page goes through sanitizeWord first;
  // this is the one path that used to skip it. Safe in practice — caseId is
  // `newId("cas")`, an ASCII nanoid — but the same caseId *is* sanitized
  // when the title block draws it, so leaving the footer unsanitized was an
  // inconsistency in an otherwise-total invariant, not a deliberate
  // exception. `Página X de Y` needs no sanitization: it is built entirely
  // from fixed pt-BR words and digits, neither of which this font can ever
  // fail to encode.
  const sanitizedCaseId = sanitizeWord(font, caseId);
  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    page.drawText(`Caso ${sanitizedCaseId}`, { x: MARGIN, y: FOOTER_Y, size: FOOTER_SIZE, font, color: GREY });
    const label = `Página ${pageNumber} de ${total}`;
    const width = font.widthOfTextAtSize(label, FOOTER_SIZE);
    page.drawText(label, { x: MARGIN + CONTENT_WIDTH - width, y: FOOTER_Y, size: FOOTER_SIZE, font, color: GREY });
  });
}

// --- entry point --------------------------------------------------------

/**
 * RF-187: lays `dossier` out on A4 pages and returns the finished PDF's
 * bytes. Pure aside from the PDF format's own internal object ids/xref
 * offsets — every date embedded in the document (creation, modification)
 * comes from `dossier.generatedAt`, never the wall clock, so the same
 * `Dossier` always produces the same visible content.
 *
 * Does no masking, sorting or translation of its own: `dossier` arrives
 * already masked (INV-007), already chronological, already pt-BR
 * (`buildDossier`, packages/core). This function only lays it out on paper
 * and defends against what paper itself cannot represent — text wider than
 * the page, and characters the standard font cannot encode.
 */
export async function renderDossierPdf(dossier: Dossier): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // PDF metadata strings go through a different encoder than page glyphs
  // (verified: `setTitle`/`setSubject` accept arbitrary Unicode without
  // throwing, unlike `drawText` with a standard font) — no WinAnsi
  // sanitization needed here.
  doc.setTitle(dossier.title);
  doc.setSubject(`Fatura ${dossier.invoiceId} — Caso ${dossier.caseId}`);
  doc.setCreationDate(dossier.generatedAt);
  doc.setModificationDate(dossier.generatedAt);

  const builder = new PageBuilder(doc);
  const fonts = { regular, bold };

  drawTitleBlock(builder, fonts, dossier);
  drawParties(builder, fonts, dossier);
  drawInvoiceSection(builder, fonts, dossier);
  drawContestedItems(builder, fonts, dossier);
  drawTimeline(builder, fonts, dossier);
  drawAttachments(builder, fonts, dossier);
  drawNotes(builder, fonts, dossier);

  drawFooters(builder.pages, regular, dossier.caseId);

  return doc.save();
}
