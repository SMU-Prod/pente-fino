import { CONDITIONAL_TERMS, FORBIDDEN_TERMS } from "./forbidden-terms.js";

export type LintViolation = {
  term: string;
  index: number;
  reason: "forbidden" | "assertive";
};

export type LintResult = { ok: boolean; violations: LintViolation[] };

function fold(text: string): string {
  // U+0300-U+036F is the Unicode "Combining Diacritical Marks" block,
  // written as an escaped range rather than literal combining characters so
  // the source file cannot silently carry a stray combining mark of its own.
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const OPEN_STRAIGHT_PRECEDED_BY = /[\s([{«:;,—–-]/;
const CLOSE_STRAIGHT_FOLLOWED_BY = /[\s.,;:!?)\]}»]/;

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/**
 * Whether the character at `index` opens a quotation. "“" (a curly
 * left quote) is unambiguous. A straight `"` is ambiguous — it is also used
 * as an inch/foot mark, a nickname delimiter, etc. — so it only counts as
 * opening when it looks like the start of a quotation: preceded by nothing,
 * whitespace or opening punctuation, and immediately followed by a
 * non-space character (an inch mark like `15"` is preceded by a digit and
 * followed by a space, so it is correctly rejected here).
 */
function looksOpening(text: string, index: number): boolean {
  const char = text[index];
  if (char === "“") return true;
  if (char !== '"') return false;
  const prev = index > 0 ? text[index - 1] : undefined;
  const next = text[index + 1];
  const prevOk = prev === undefined || OPEN_STRAIGHT_PRECEDED_BY.test(prev);
  const nextOk = next !== undefined && !isWhitespace(next);
  return prevOk && nextOk;
}

/** Mirror of `looksOpening` for the closing side of a straight quote. */
function looksClosing(text: string, index: number): boolean {
  const char = text[index];
  if (char === "”") return true;
  if (char !== '"') return false;
  const prev = index > 0 ? text[index - 1] : undefined;
  const next = text[index + 1];
  const prevOk = prev !== undefined && !isWhitespace(prev);
  const nextOk = next === undefined || CLOSE_STRAIGHT_FOLLOWED_BY.test(next);
  return prevOk && nextOk;
}

/**
 * Finds the index of the quote character that closes the quotation opened
 * at `start - 1`. If another quote that looks like a fresh opener is found
 * first, the original open is treated as broken (it never closes) rather
 * than pairing it with something unrelated further down the string — see
 * the "abort on fresh opener" note on `quotedRanges` for why this matters.
 */
function findClose(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char !== '"' && char !== "“" && char !== "”") continue;
    if (looksClosing(text, index)) return index;
    if (looksOpening(text, index)) return -1;
  }
  return -1;
}

/**
 * Character ranges covered by double quotes, where a citation may live.
 *
 * This is not a plain "pair up the quote characters" regex. Two failure
 * modes were probed and are guarded against explicitly, because a
 * quoted-citation exemption that is wrong in the unsafe direction — treating
 * the system's own assertion as an allowed quotation — is the one this gate
 * exists to prevent:
 *
 * 1. A straight quote used for something other than a citation (an inch
 *    mark, a nickname) must never open a span, or a real assertive claim
 *    between it and some unrelated later quote character gets swallowed as
 *    "quoted". `looksOpening`/`looksClosing` apply an open/close shape
 *    heuristic (the same one behind automatic "smart quote" conversion) so
 *    a quote glued to the preceding character with a space after it is
 *    never treated as an opener.
 * 2. A quotation that never actually closes must not reach across the rest
 *    of the string and pair itself with an unrelated, independent
 *    quotation later on. `findClose` bails out as soon as it meets a fresh
 *    opener before a real closer, so the broken open stays broken and the
 *    fresh opener gets evaluated on its own.
 */
function quotedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let index = 0;
  while (index < text.length) {
    if (looksOpening(text, index)) {
      const close = findClose(text, index + 1);
      if (close !== -1) {
        ranges.push([index, close + 1]);
        index = close + 1;
        continue;
      }
    }
    index++;
  }
  return ranges;
}

function inside(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function findWord(haystack: string, needle: string): number[] {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu");
  const hits: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(haystack)) !== null) hits.push(match.index);
  return hits;
}

/**
 * Deterministic gate that runs before any generated text reaches the user
 * (INV-004, INV-005). Folding strips accents so "juridico" is caught along
 * with "jurídico"; indices are reported against the folded text, which has
 * the same length as the original because folding only removes combining
 * marks and lowercases.
 */
export function lintUserFacingText(text: string): LintResult {
  const folded = fold(text);
  const quoted = quotedRanges(text);
  const violations: LintViolation[] = [];

  for (const term of FORBIDDEN_TERMS) {
    for (const index of findWord(folded, fold(term))) {
      violations.push({ term: fold(term), index, reason: "forbidden" });
    }
  }

  for (const term of CONDITIONAL_TERMS) {
    for (const index of findWord(folded, fold(term))) {
      if (!inside(quoted, index)) {
        violations.push({ term: fold(term), index, reason: "assertive" });
      }
    }
  }

  violations.sort((a, b) => a.index - b.index);
  return { ok: violations.length === 0, violations };
}
