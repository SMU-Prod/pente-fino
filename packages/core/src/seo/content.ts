/**
 * E10's public content surface (`/cobranca/[issuer]/[charge]`, RF-280/RF-281)
 * is a page built from a value authored once and stored as text: a seed in
 * `packages/db` writes `serializeSeoContent(content)` into
 * `seo_pages.body_md`, and the route reads the column back and calls
 * `parseSeoContent` to render it. This module owns both directions of that
 * round trip, plus the shared shape for the slug the two sides key on.
 *
 * The markdown subset is deliberately tiny: `## ` and `### ` headings, and
 * blank-line-separated paragraphs. Nothing else — no lists, no inline
 * emphasis, no links, no raw HTML. That narrowness is not an oversight; the
 * route's renderer (E10 Task 3) turns parsed blocks into React elements by
 * hand, with no markdown library and no `dangerouslySetInnerHTML`
 * (RNF-05). A format this module cannot fully enumerate is a format that
 * renderer cannot safely turn into elements, so `parseSeoContent` throws on
 * anything outside the exact grammar `serializeSeoContent` emits — it is a
 * matched pair, not a permissive markdown reader.
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** One entry of the page's "Perguntas frequentes" block; also the source of
 * the route's JSON-LD `FAQPage` (`Question`/`acceptedAnswer` per entry, in
 * order), which is why entry order must survive the round trip exactly. */
export type SeoFaqEntry = { question: string; answer: string };

/** One `## ` section: a heading plus one or more paragraphs under it. */
export type SeoSection = { heading: string; paragraphs: string[] };

export type SeoPageContent = {
  /** One paragraph, rendered before any heading. */
  intro: string;
  /** Rendered in order, each as `## heading` + its paragraphs. */
  sections: SeoSection[];
  /** Rendered under `SEO_FAQ_HEADING`, each entry as `### question` +
   * `answer`. May be empty — a page with nothing to ask is still a valid
   * page, and an empty array round-trips by the heading not appearing at
   * all (see `serializeSeoContent`). */
  faq: SeoFaqEntry[];
  /** The §7.0 disclosure: where this description came from, and that a
   * charge appearing here is not a claim that any company did anything
   * wrong. Always the last block on the page. */
  provenance: string;
};

/**
 * Fixed so the seed (which writes it) and the parser (which looks for it)
 * never drift into two different strings for the same concept — a drift
 * there would make every FAQ on every page invisible to the parser instead
 * of failing loudly.
 */
export const SEO_FAQ_HEADING = "Perguntas frequentes";

/**
 * Same reasoning as `SEO_FAQ_HEADING`. Named after CLAUDE.md §7.0's own
 * framing ("Como este léxico foi construído") — the page-level disclosure
 * is the same honesty move, one level up: not just how the lexicon was
 * built, but how *this page's* text was built from it.
 */
export const SEO_PROVENANCE_HEADING = "Como esta página foi construída";

/**
 * Thrown by `parseSeoContent` for any markdown it cannot map back onto a
 * `SeoPageContent` — a distinct class (rather than a bare `Error`) so a
 * caller building a corpus (E10 Task 2's seed test) can assert on the type,
 * not just pattern-match the message.
 */
export class SeoContentParseError extends Error {}

const H2_PREFIX = "## ";
const H3_PREFIX = "### ";

// --- serialize ---------------------------------------------------------

/**
 * Every block of the page, in emission order, as opaque strings — a block
 * is either a heading line (`## `/`### ` + text) or a paragraph's raw text.
 * Joining them with a blank line between each is what makes the format
 * "blank-line-separated paragraphs": the join is the only place a blank
 * line is ever produced, so there is exactly one way to produce this
 * markdown and (by construction) exactly one grammar for `parseSeoContent`
 * to invert.
 */
function collectBlocks(content: SeoPageContent): string[] {
  const blocks: string[] = [content.intro];

  for (const section of content.sections) {
    blocks.push(`${H2_PREFIX}${section.heading}`);
    blocks.push(...section.paragraphs);
  }

  // An empty `faq` array omits the heading entirely rather than emitting
  // "## Perguntas frequentes" with nothing under it — the latter is exactly
  // the "heading with no body" shape `parseSeoContent` rejects, so leaving
  // it out is what keeps `faq: []` round-tripping at all.
  if (content.faq.length > 0) {
    blocks.push(`${H2_PREFIX}${SEO_FAQ_HEADING}`);
    for (const entry of content.faq) {
      blocks.push(`${H3_PREFIX}${entry.question}`);
      blocks.push(entry.answer);
    }
  }

  blocks.push(`${H2_PREFIX}${SEO_PROVENANCE_HEADING}`);
  blocks.push(content.provenance);

  return blocks;
}

export function serializeSeoContent(content: SeoPageContent): string {
  return collectBlocks(content).join("\n\n");
}

// --- parse ---------------------------------------------------------------

/** A maximal run of non-blank lines, plus the 1-based line it starts on —
 * the line number is what lets every rejection below name the offending
 * line instead of just quoting text with no place to look. */
type RawBlock = { text: string; line: number };

function splitBlocks(markdown: string): RawBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: RawBlock[] = [];
  let current: string[] = [];
  let currentStartLine = 0;

  const flush = () => {
    if (current.length > 0) {
      blocks.push({ text: current.join("\n"), line: currentStartLine });
      current = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    // `noUncheckedIndexedAccess` types `lines[i]` as possibly `undefined`
    // even though the loop bound guarantees it never is; the `?? ""`
    // satisfies the compiler and is not expected to ever be exercised.
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (current.length === 0) currentStartLine = i + 1; // 1-based
    current.push(line);
  }
  flush();

  return blocks;
}

type ClassifiedBlock = { level: 0 | 2 | 3; text: string };

/**
 * Tells a heading block from a paragraph block by looking only at whether
 * the block's *first line* opens with `#` — never by scanning the whole
 * block for a `#` character. That is what lets a paragraph contain a `#`
 * mid-sentence ("o item aparece como #123 na fatura") and still round-trip
 * as plain text: the character only means "heading" at column 0 of a block.
 *
 * A block whose first line starts with `#` but is not exactly `## ` or
 * `### ` (a bare `#`, `#### `, `##semespaço`, ...) is not part of this
 * format's subset and is rejected as an unknown block type. A block that
 * opens with a heading marker but spans more than one line means the
 * source markdown ran a heading and its body together with no blank line
 * between them — also not something `serializeSeoContent` ever produces —
 * and is rejected for the same reason.
 */
function classify(block: RawBlock): ClassifiedBlock {
  const firstNewline = block.text.indexOf("\n");
  const firstLine = firstNewline === -1 ? block.text : block.text.slice(0, firstNewline);

  if (!firstLine.startsWith("#")) {
    return { level: 0, text: block.text };
  }

  if (firstNewline !== -1) {
    throw new SeoContentParseError(
      `a heading must be its own block, separated from its body by a blank line, at line ${block.line}: ${JSON.stringify(firstLine)}`,
    );
  }

  if (block.text.startsWith(H3_PREFIX)) {
    return { level: 3, text: block.text.slice(H3_PREFIX.length) };
  }
  if (block.text.startsWith(H2_PREFIX)) {
    return { level: 2, text: block.text.slice(H2_PREFIX.length) };
  }

  throw new SeoContentParseError(`unknown block type at line ${block.line}: ${JSON.stringify(block.text)}`);
}

function headingWithNoBody(block: RawBlock, headingText: string): SeoContentParseError {
  return new SeoContentParseError(`heading with no body, at line ${block.line}: ${JSON.stringify(headingText)}`);
}

/**
 * The three phases a document moves through, in order, never backward:
 * every section (`## `) precedes the FAQ block, which precedes provenance.
 * This mirrors `SeoPageContent`'s own field order and is what turns a
 * mis-ordered or duplicated heading (a stray section after the FAQ, a
 * second provenance block) into an explicit rejection instead of a value
 * that silently doesn't match what `serializeSeoContent` would have
 * produced for it.
 */
type ParsePhase = "sections" | "faq" | "provenance";

export function parseSeoContent(markdown: string): SeoPageContent {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) {
    throw new SeoContentParseError("markdown has no content to parse");
  }

  const introBlock = blocks[0]!;
  const introClassified = classify(introBlock);
  if (introClassified.level !== 0) {
    throw new SeoContentParseError(
      `expected the intro paragraph first, found a heading at line ${introBlock.line}: ${JSON.stringify(introBlock.text)}`,
    );
  }
  const intro = introClassified.text;

  const sections: SeoSection[] = [];
  const faq: SeoFaqEntry[] = [];
  let provenance: string | null = null;
  let phase: ParsePhase = "sections";

  let i = 1;
  while (i < blocks.length) {
    const block = blocks[i]!;
    const classified = classify(block);

    if (classified.level === 0) {
      throw new SeoContentParseError(
        `expected a heading, found a paragraph at line ${block.line}: ${JSON.stringify(block.text)}`,
      );
    }

    if (classified.level === 3) {
      if (phase !== "faq") {
        throw new SeoContentParseError(
          `a ### heading outside the FAQ section, at line ${block.line}: ${JSON.stringify(classified.text)}`,
        );
      }
      const answerBlock = blocks[i + 1];
      if (answerBlock === undefined || classify(answerBlock).level !== 0) {
        throw headingWithNoBody(block, classified.text);
      }
      faq.push({ question: classified.text, answer: answerBlock.text });
      i += 2;
      continue;
    }

    // classified.level === 2 from here on.
    if (classified.text === SEO_FAQ_HEADING) {
      if (phase !== "sections") {
        throw new SeoContentParseError(`the "${SEO_FAQ_HEADING}" heading out of order, at line ${block.line}`);
      }
      const firstEntryBlock = blocks[i + 1];
      if (firstEntryBlock === undefined || classify(firstEntryBlock).level !== 3) {
        throw headingWithNoBody(block, classified.text);
      }
      phase = "faq";
      i += 1;
      continue;
    }

    if (classified.text === SEO_PROVENANCE_HEADING) {
      // No separate "already saw provenance" guard is needed here: the
      // "must be the last block" check just below already rejects a second
      // occurrence, because reaching this branch at all means the loop
      // hasn't ended yet, which only happens if the *first* provenance
      // block was not actually last.
      const bodyBlock = blocks[i + 1];
      if (bodyBlock === undefined || classify(bodyBlock).level !== 0) {
        throw headingWithNoBody(block, classified.text);
      }
      if (i + 2 !== blocks.length) {
        const trailing = blocks[i + 2]!;
        throw new SeoContentParseError(
          `content after the provenance section, which must be the last block, at line ${trailing.line}: ${JSON.stringify(trailing.text)}`,
        );
      }
      provenance = bodyBlock.text;
      phase = "provenance";
      i += 2;
      continue;
    }

    // A regular section heading.
    if (phase !== "sections") {
      throw new SeoContentParseError(
        `a section heading after the FAQ or provenance section, at line ${block.line}: ${JSON.stringify(classified.text)}`,
      );
    }
    const paragraphs: string[] = [];
    let j = i + 1;
    while (j < blocks.length) {
      const candidate = blocks[j]!;
      if (classify(candidate).level !== 0) break;
      paragraphs.push(candidate.text);
      j++;
    }
    if (paragraphs.length === 0) {
      throw headingWithNoBody(block, classified.text);
    }
    sections.push({ heading: classified.text, paragraphs });
    i = j;
  }

  if (provenance === null) {
    throw new SeoContentParseError("missing the provenance section");
  }

  return { intro, sections, faq, provenance };
}

// --- charge slug ---------------------------------------------------------

/**
 * Lowercase `a-z0-9`, hyphen-separated, no leading/trailing/double hyphen —
 * strict rather than normalising (no case-folding, no trimming) because
 * this shape is checked on *both* sides of a boundary that must not drift:
 * `packages/db`'s seed writes `seo_pages.charge_slug` with it, and the route
 * matches the URL's `[charge]` segment against the same rule. A normalising
 * validator could let the seed and the route each "fix up" a slightly
 * different input into the same value while still disagreeing about what a
 * *raw* slug looks like — this rejects instead, so the one place slugs are
 * typed (the seed's literals) is the only place they can go wrong.
 */
const SEO_CHARGE_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSeoChargeSlug(value: string): boolean {
  return SEO_CHARGE_SLUG_SHAPE.test(value);
}

/**
 * Validates and returns `value` unchanged, or throws. A slug that fails
 * this on the seed side must never reach `seo_pages.charge_slug` — a bad
 * slug written once is a 404 for as long as the row exists, since the
 * route checks the identical shape (`isSeoChargeSlug`) before it will even
 * attempt a lookup.
 */
export function seoChargeSlug(value: string): string {
  if (!isSeoChargeSlug(value)) {
    throw new RangeError(
      `not a valid charge slug (expected lowercase a-z0-9, hyphen-separated, no leading/trailing/double hyphen): ${JSON.stringify(value)}`,
    );
  }
  return value;
}
