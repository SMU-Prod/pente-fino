import type { ReadDocument } from "../ports/document-reader.js";

export type Anchor = "total" | "due_date" | "cnpj";

export type QualityScore = {
  score: number;
  signals: {
    printableRatio: number;
    anchorsFound: Anchor[];
    densityPerPage: number;
  };
  route: "text" | "vision";
};

/** RF-107's threshold, named here so the number has one home. */
export const VISION_THRESHOLD = 0.6;

/** A page of an invoice carries far more than this; below it, something is wrong. */
const HEALTHY_CHARS_PER_PAGE = 400;

const ANCHOR_PATTERNS: Array<{ anchor: Anchor; pattern: RegExp }> = [
  { anchor: "total", pattern: /\b(total|valor\s+a\s+pagar|valor\s+total)\b/i },
  { anchor: "due_date", pattern: /\b(vencimento|vence\s+em|data\s+de\s+vencimento)\b/i },
  { anchor: "cnpj", pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/ },
];

/**
 * Scores how much of an invoice actually came out of the file, and decides
 * RF-107's route.
 *
 * Three signals, each verifiable on its own:
 *
 *  - `printableRatio` — the share of characters that are letters, digits,
 *    whitespace or ordinary punctuation. OCR noise and a broken encoding
 *    both show up here as a low ratio, and a native PDF sits near 1.
 *  - `anchorsFound` — every Brazilian invoice states a total, a due date
 *    and the issuer's CNPJ. Text that carries none of the three is not a
 *    readable invoice, whatever its character ratio says.
 *  - `densityPerPage` — a page with a text layer but almost no text is a
 *    scan with a stray caption, not a document that was read.
 *
 * They are combined rather than gated so one weak signal does not veto two
 * strong ones; the anchors carry the most weight, because they are the
 * hardest to satisfy by accident.
 *
 * Accepted limitations (probed, not fixed here, because closing them needs
 * invoice classification, which is a different job than judging extraction
 * fidelity):
 *
 * 1. Anchor patterns match a contiguous, literally-phrased token. A CNPJ
 *    split across a line break, or a total introduced by a phrasing this
 *    list does not know, will not count towards `anchorsFound`. The score
 *    usually survives this anyway — the two other signals, and whichever
 *    anchors did match, carry a genuinely well-extracted page over the
 *    threshold — but `anchorsFound` itself can under-report on that page.
 * 2. The anchors test for the presence of invoice-shaped words, not that
 *    the document is an invoice. Unrelated prose that happens to use the
 *    words "total" and "vencimento" scores as if it were one. Real input
 *    to this pipeline is user-uploaded telecom/utility bills, not
 *    arbitrary text, so this is treated as an accepted risk rather than
 *    solved by classification here.
 * 3. `printableRatio` treats every Unicode letter as printable, so a
 *    homoglyph substitution (Cyrillic look-alikes, `0`/`O` confusion) is
 *    invisible to it on its own. It is usually still caught, because the
 *    same substitution tends to break the anchor pattern it falls inside —
 *    but a corrupted page whose anchors happen to survive intact would
 *    still score well on this signal alone.
 */
export function extractionQuality(doc: ReadDocument): QualityScore {
  if (!doc.hasTextLayer) {
    return {
      score: 0,
      signals: { printableRatio: 0, anchorsFound: [], densityPerPage: 0 },
      route: "vision",
    };
  }

  const text = doc.pages.join("\n");
  const printable = text.replace(/[^\p{L}\p{N}\s.,:;/()%$-]/gu, "");
  const printableRatio = text.length === 0 ? 0 : printable.length / text.length;

  const anchorsFound = ANCHOR_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ anchor }) => anchor);

  const pages = Math.max(doc.pageCount, 1);
  const densityPerPage = text.length / pages;
  const densitySignal = Math.min(densityPerPage / HEALTHY_CHARS_PER_PAGE, 1);

  const score =
    printableRatio * 0.3 +
    (anchorsFound.length / ANCHOR_PATTERNS.length) * 0.5 +
    densitySignal * 0.2;

  return {
    score: Math.max(0, Math.min(1, score)),
    signals: { printableRatio, anchorsFound, densityPerPage },
    route: score >= VISION_THRESHOLD ? "text" : "vision",
  };
}
