import { CONDITIONAL_TERMS, FORBIDDEN_TERMS } from "./forbidden-terms.js";

export type LintViolation = {
  term: string;
  index: number;
  reason: "forbidden" | "assertive";
};

export type LintResult = { ok: boolean; violations: LintViolation[] };

export type LintOptions = {
  /** Character ranges that are verbatim quotation of a norm or of a third party. */
  citations?: Array<{ start: number; end: number }>;
};

function fold(text: string): string {
  // U+0300-U+036F is the Unicode "Combining Diacritical Marks" block,
  // written as an escaped range rather than literal combining characters so
  // the source file cannot silently carry a stray combining mark of its own.
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

type WordHit = { index: number; end: number };

// Endings where Portuguese pluralizes by dropping the final "l" and adding
// "is" rather than appending "s"/"es" — ilegal/ilegais, judicial/judiciais.
const L_PLURAL_ENDING = /(?:al|el|il|ol|ul)$/;

/**
 * Extends an already-escaped last word with its regular Portuguese plural,
 * so the term list stays singular while the matcher still catches the
 * inflected form a real message would use:
 *   - words ending in -al/-el/-il/-ol/-ul drop the "l" and add "is"
 *     (ilegal -> ilegais, judicial -> judiciais);
 *   - every other word optionally takes a trailing "s" or "es"
 *     (advogado -> advogados, parecer -> pareceres).
 * This is deliberately not general morphology: only this one regular
 * pattern, applied only to the final word of the term, per §14.3.
 */
function withPlural(word: string): string {
  if (L_PLURAL_ENDING.test(word)) {
    const stem = word.slice(0, -1);
    return `(?:${word}|${stem}is)`;
  }
  return `${word}(?:es|s)?`;
}

/**
 * Builds a whole-word matcher for `needle`. A multi-word needle (e.g. "em
 * seu nome") is split on its literal spaces and the pieces are rejoined
 * with `\s+`, so any run of one or more whitespace characters between the
 * words — a line break, a tab, a non-breaking space, or more than one
 * plain space — counts as the same gap a single ASCII space would. Each
 * piece is escaped after the split, so a literal space is never itself
 * escaped or folded into a character class. The final word is then widened
 * to also accept its regular plural (see `withPlural`), since the boundary
 * lookaround below still keeps a bare prefix like "advogadoria" from
 * matching "advogado".
 */
function findWord(haystack: string, needle: string): WordHit[] {
  const words = needle.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const lastIndex = words.length - 1;
  const pattern = words.map((word, i) => (i === lastIndex ? withPlural(word) : word)).join("\\s+");
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "gu");
  const hits: WordHit[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(haystack)) !== null) {
    hits.push({ index: match.index, end: match.index + match[0].length });
  }
  return hits;
}

/** Whether the half-open range [start, end) falls entirely inside at least one declared citation. */
function isCited(citations: Array<{ start: number; end: number }>, start: number, end: number): boolean {
  return citations.some((citation) => start >= citation.start && end <= citation.end);
}

/**
 * Deterministic gate that runs before any generated text reaches the user
 * (INV-004, INV-005). Folding strips accents so "juridico" is caught along
 * with "jurídico"; indices are reported against the folded text, which has
 * the same length as the original because folding only removes combining
 * marks and lowercases.
 *
 * The conditional terms of PRD §14.3 ("indevido", "indevida", "ilegal") are
 * allowed only when quoting a norm or a third party. This lint has no way
 * to infer that attribution from the text itself — quotation marks are
 * punctuation, not proof of who is speaking — so it does not try. The
 * caller must say so explicitly through `options.citations`: a legal
 * reference always comes from the rule that fired, never from the model
 * (RF-161), and a third-party reply arrives in its own field, so the caller
 * always knows the exact span before this function is ever called.
 *
 * With no `citations`, nothing is exempt: the conditional terms are
 * violations wherever they appear, quoted or not. A conditional term is
 * exempt only when its whole match falls inside a declared citation range.
 * `FORBIDDEN_TERMS` are never exempt, citation or not — §14.3 grants the
 * quotation exemption to the conditional terms alone.
 */
export function lintUserFacingText(text: string, options?: LintOptions): LintResult {
  const folded = fold(text);
  const citations = options?.citations ?? [];
  const violations: LintViolation[] = [];

  for (const term of FORBIDDEN_TERMS) {
    for (const hit of findWord(folded, fold(term))) {
      violations.push({ term: fold(term), index: hit.index, reason: "forbidden" });
    }
  }

  for (const term of CONDITIONAL_TERMS) {
    for (const hit of findWord(folded, fold(term))) {
      if (!isCited(citations, hit.index, hit.end)) {
        violations.push({ term: fold(term), index: hit.index, reason: "assertive" });
      }
    }
  }

  violations.sort((a, b) => a.index - b.index);
  return { ok: violations.length === 0, violations };
}
