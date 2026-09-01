/**
 * Guards `pattern.spec.match` / `spec.notMatch` against catastrophic
 * backtracking (ReDoS) before they are ever compiled into a `RegExp`.
 *
 * ## Same threat model as `expression.ts`, different payload
 *
 * A `rules` row is configuration edited through an admin panel (ADR-06,
 * RF-301), never code reviewed. `expression.ts`'s doc comment explains why
 * that rules out `eval`/`new Function` for `threshold`/`arithmetic`: an
 * evaluable admin-supplied string is a code-execution path. A pathological
 * `pattern.match` is the same author, the same lack of review, with a
 * different payload - not remote code execution, but a regex that takes
 * exponential time on an ordinary invoice line item hangs the ingest
 * worker, which is the one thing standing between a user and their report.
 * Worth exactly the same seriousness.
 *
 * ## What actually holds, and what does not
 *
 * Three defences were on the table:
 *
 * 1. **Cap the pattern's length.** Cheap, but does not hold on its own:
 *    the canonical catastrophic-backtracking shape, `(a+)+`, is nine
 *    characters. A length cap would have to be absurdly small to matter,
 *    and even then would not stop it - the exploding cost comes from the
 *    *input* the pattern is matched against (an ordinary ~30-50 character
 *    item description), not from the pattern's own length. Kept anyway as
 *    a cheap, independent second line of defence (`MAX_PATTERN_LENGTH`
 *    below), but never relied on alone.
 * 2. **Run the match under a bounded time/step budget.** Not implementable
 *    here without breaking `packages/core`'s "no I/O" contract: V8's
 *    native regex engine cannot be interrupted mid-execution from the same
 *    thread, so a real budget would mean either a worker thread (I/O-
 *    shaped machinery this package does not have) or writing a bespoke
 *    backtracking VM with its own step counter (reimplementing a regex
 *    engine - far outside this task). Rejected as impractical here, not
 *    because it is uninteresting.
 * 3. **Statically reject the constructs that make backtracking explode.**
 *    What this module does. Every known catastrophic-backtracking shape
 *    reduces to one of two patterns in the regex's own structure:
 *      - a **quantified group whose content contains another quantifier**
 *        (`(a+)+`, `(a*)*`, `(a?)+` - the last is the classic textbook
 *        case even without a `+`/`*` inside, since `?` inside a repeated
 *        group is exactly as combinatorially explosive), and
 *      - **alternation inside a quantified group** (`(a|a)+`, `(a|ab)+`).
 *    Rejecting both, at any nesting depth, closes off the actual
 *    mechanism of exponential blow-up rather than guessing at examples of
 *    it. See `safe-regex.test.ts` for empirical timing proof this is not
 *    merely a theoretical concern.
 *
 * ## What a rule author can no longer write
 *
 * - A quantifier (`*`, `+`, `?`, `{m,n}`) applied to a group that itself
 *   contains a quantifier, at any depth: `(a+)+`, `(a*)?`, `((a+)b)*`.
 * - Alternation inside a quantified group: `(a|b)+`, `(foo|bar)*`.
 * - A pattern longer than `MAX_PATTERN_LENGTH` characters.
 *
 * ## What is still fully expressible
 *
 * - A quantifier used once, not wrapped in a further repeated group:
 *   `SVA+`, `\d{2,4}`, `SERVICOS.*DIGITAL`, `(SVA)`.
 * - A repeated group whose content has no quantifier or alternation of
 *   its own: `(AB)+`, `(SVA)+` (a literal, fixed sub-sequence repeated).
 * - Alternation on its own, not inside a repeated group - exactly the
 *   shape a keyword lexicon needs: `SEGURO|PROTECAO|GARANTIA ESTENDIDA`.
 * - Character classes, including quantified ones: `[A-Z]+`, `[0-9]{2,4}`.
 * - Anchors, `.`, escapes, non-capturing/named/lookaround group syntax
 *   (`(?:...)`, `(?<name>...)`, `(?=...)`, `(?!...)`) - these are scanned
 *   like any other group for the two forbidden shapes above, but are not
 *   forbidden themselves.
 *
 * None of this is a full regex parser - it is a purpose-built scanner for
 * exactly the two dangerous shapes above, erring toward rejecting an
 * ambiguous construct rather than risking a false negative.
 */

export class UnsafePatternError extends Error {}

const MAX_PATTERN_LENGTH = 200;

type GroupScan = {
  /** Index just past the end of this group's content (before the closing `)`, or end of string at the top level). */
  end: number;
  /** A `|` was seen at this group's own nesting level (not inside a deeper sub-group). */
  hasTopLevelAlternation: boolean;
  /** A quantifier appears anywhere within this group's content, at this level or any deeper one. */
  hasAnyQuantifier: boolean;
};

/**
 * Scans a group's content starting at `start` (just after its opening `(`,
 * or position 0 for the whole pattern). Stops at an unescaped `)` or the
 * end of the string; the caller is responsible for consuming that `)`.
 */
function scanGroup(source: string, start: number): GroupScan {
  let i = start;
  let hasTopLevelAlternation = false;
  let hasAnyQuantifier = false;

  while (i < source.length) {
    const ch = source[i];

    if (ch === ")") {
      break;
    }

    if (ch === "\\") {
      i = Math.min(i + 2, source.length);
      continue;
    }

    if (ch === "[") {
      i = scanCharacterClass(source, i);
      i = skipQuantifierIfPresent(source, i, () => {
        hasAnyQuantifier = true;
      });
      continue;
    }

    if (ch === "(") {
      const contentStart = skipGroupOpener(source, i + 1);
      const inner = scanGroup(source, contentStart);
      const closeIndex = inner.end; // points at the `)` or end of string
      const afterClose = closeIndex < source.length ? closeIndex + 1 : closeIndex;

      let quantified = false;
      const nextIndex = skipQuantifierIfPresent(source, afterClose, () => {
        quantified = true;
      });

      if (quantified) {
        if (inner.hasTopLevelAlternation) {
          throw new UnsafePatternError(
            `unsafe pattern: alternation inside a quantified group ("${source.slice(i, nextIndex)}") can backtrack catastrophically`,
          );
        }
        if (inner.hasAnyQuantifier) {
          throw new UnsafePatternError(
            `unsafe pattern: a quantified group containing another quantifier ("${source.slice(i, nextIndex)}") can backtrack catastrophically`,
          );
        }
        hasAnyQuantifier = true;
      } else if (inner.hasTopLevelAlternation || inner.hasAnyQuantifier) {
        // Not itself repeated, so not dangerous on its own, but its
        // content still counts toward "contains a quantifier" for
        // whichever ancestor group ends up wrapping this one.
        hasAnyQuantifier = true;
      }

      i = nextIndex;
      continue;
    }

    if (ch === "|") {
      hasTopLevelAlternation = true;
      i++;
      continue;
    }

    if (ch === "*" || ch === "+" || ch === "?") {
      hasAnyQuantifier = true;
      i++;
      continue;
    }

    if (ch === "{") {
      const braceEnd = tryParseBraceQuantifier(source, i);
      if (braceEnd !== null) {
        hasAnyQuantifier = true;
        i = braceEnd;
        continue;
      }
      i++; // a literal "{" that does not form a valid quantifier
      continue;
    }

    i++;
  }

  return { end: i, hasTopLevelAlternation, hasAnyQuantifier };
}

/** Advances past `[...]`, honouring `\]`, a literal leading `]`/`^]`, and an unterminated class. */
function scanCharacterClass(source: string, openBracketIndex: number): number {
  let i = openBracketIndex + 1;
  if (source[i] === "^") i++;
  if (source[i] === "]") i++; // a `]` right after `[` or `[^` is a literal member, not the closer
  while (i < source.length && source[i] !== "]") {
    i = source[i] === "\\" ? Math.min(i + 2, source.length) : i + 1;
  }
  return i < source.length ? i + 1 : i; // consume the closing `]`, if any
}

/** Skips `?:`, `?=`, `?!`, `?<=`, `?<!`, or a named group's `?<name>` right after a group's `(`. */
function skipGroupOpener(source: string, afterOpenParen: number): number {
  if (source[afterOpenParen] !== "?") return afterOpenParen;
  const marker = source[afterOpenParen + 1];
  if (marker === ":" || marker === "=" || marker === "!") {
    return afterOpenParen + 2;
  }
  if (marker === "<") {
    const lookbehind = source[afterOpenParen + 2];
    if (lookbehind === "=" || lookbehind === "!") {
      return afterOpenParen + 3;
    }
    let i = afterOpenParen + 2;
    while (i < source.length && source[i] !== ">") i++;
    return i < source.length ? i + 1 : i;
  }
  return afterOpenParen;
}

/** `{m}`, `{m,}` or `{m,n}` - the only brace forms JS regex treats as a quantifier; anything else is a literal `{`. */
const BRACE_QUANTIFIER = /^\{\d+(,\d*)?\}/;

function tryParseBraceQuantifier(source: string, braceIndex: number): number | null {
  const match = BRACE_QUANTIFIER.exec(source.slice(braceIndex));
  return match === null ? null : braceIndex + match[0].length;
}

/**
 * If a quantifier (`* + ? {m,n}`) sits at `pos`, calls `onQuantifier` and
 * returns the index just past it (including a lazy `?` right after it, so
 * that trailing `?` is not mistaken for a second, independent quantifier).
 * Otherwise returns `pos` unchanged.
 */
function skipQuantifierIfPresent(source: string, pos: number, onQuantifier: () => void): number {
  const ch = source[pos];
  let end: number | null = null;

  if (ch === "*" || ch === "+" || ch === "?") {
    end = pos + 1;
  } else if (ch === "{") {
    end = tryParseBraceQuantifier(source, pos);
  }

  if (end === null) return pos;
  onQuantifier();
  return source[end] === "?" ? end + 1 : end; // absorb a lazy modifier
}

/**
 * Rejects `source` if it is too long, or if it contains a quantified group
 * with a nested quantifier or internal alternation. Does not compile the
 * pattern - callers still need `new RegExp(source)` for that.
 */
export function assertSafePattern(source: string): void {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new UnsafePatternError(`pattern exceeds the ${MAX_PATTERN_LENGTH} character limit`);
  }
  scanGroup(source, 0);
}

/** `assertSafePattern` followed by `new RegExp` - the one call site `pattern.ts` needs. */
export function compileSafePattern(source: string): RegExp {
  assertSafePattern(source);
  return new RegExp(source);
}
