/**
 * Normalises an invoice line description so the same recurring item matches
 * across issuers and billing cycles (RF-122).
 *
 * The string is decomposed to NFD, stripped of accents, and uppercased,
 * then split into whitespace-separated tokens that are each normalised on
 * their own. Working token-by-token - instead of running a chain of
 * regexes across the whole string - is what lets each token's outcome
 * (kept, dropped, or partially rewritten) stand on its own: no rule can
 * shift a token boundary out from under the next rule, and no smuggled
 * marker character is needed to carry state between rules.
 *
 * ## The four decisions, applied to each token
 *
 * 1. **Drop a letterless token.** A token with no A-Z letter at all is a
 *    pure number, date, or code - a variable number by definition - and is
 *    removed entirely. "07/2026" and "01310-100" both go this way.
 * 2. **Remove a date/cycle-shaped chunk.** Within a token that does contain
 *    a letter (so it survived decision 1), a chunk of exactly two digit
 *    groups joined by a single "/", "." or "-", where at least one group is
 *    exactly four digits, is replaced by a single space. This is what lets
 *    "Mensalidade-01/2026" and "Mensalidade-02/2026" collapse to the same
 *    "MENSALIDADE" even though the cycle number is glued to the word with
 *    no space of its own. A chain of three or more groups never qualifies
 *    here, no matter how many of its groups happen to be four digits long
 *    - it is left for decision 3 instead.
 * 3. **Fuse punctuation next to a digit.** Punctuation directly between two
 *    alphanumeric characters vanishes - with no space inserted, so the
 *    characters fuse into one - whenever at least one of the two
 *    neighbours is a digit: "4.5G" becomes "45G", "4-G" becomes "4G",
 *    "10-GB" becomes "10GB", each staying distinct from the plain form it
 *    could otherwise collapse into. Punctuation between two letters is
 *    untouched here and falls through to decision 4 instead, so
 *    "PLANO-MASTER" still splits into "PLANO" and "MASTER".
 * 4. **Space out, split, and drop the leftovers.** Every remaining run of
 *    non-alphanumeric characters becomes a single space; the token is then
 *    split on whitespace, and any resulting piece that is purely numeric is
 *    dropped. This is what turns "ADICIONADO(SVA)" into "ADICIONADO SVA",
 *    and clears a bare digit run that decisions 2-3 left exposed (e.g. a
 *    three-or-more-group chain like "2026-08-000123", once fusion has
 *    joined its groups into one run with nothing to fuse onto).
 *
 * The pieces every token survives as are rejoined with single spaces and
 * trimmed.
 *
 * ## Known limitation
 *
 * Decision 1 drops any whitespace-separated token that has no letter at
 * all, with no way to tell a meaningless identifier from one that matters.
 * Two lines differing only in such a token - a premium short code ("40041"
 * vs "40042"), a protocol number ("Protocolo 2026-08-000123" vs
 * "...-000456"), a postal code ("CEP 01310-100" vs "CEP 04543-011"), or a
 * day count ("Multa por atraso 30 dias" vs "...15 dias") - normalise to the
 * exact same string. This is a deliberate trade-off, not an oversight: a
 * shape-only function cannot distinguish an identifier from a billing cycle
 * without more context than a string carries, and this function chooses to
 * favour matching a recurring line across cycles over telling apart two
 * coincidentally-shaped one-off codes. Anything in E2 that matches pattern
 * rules against this output must not treat equal normalised descriptions as
 * proof of the same billable item.
 */
export function normalizeDescription(input: string): string {
  const upper = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  const tokens = upper.split(/\s+/).filter((token) => token.length > 0);

  return tokens
    .flatMap((token) => normalizeToken(token))
    .join(" ")
    .trim();
}

/** Whether a token contains at least one A-Z letter. */
const HAS_LETTER = /[A-Z]/;

/** The longest run of two-or-more digit groups joined by "/", "." or "-". */
const DIGIT_GROUP_CHAIN = /\d+(?:[\/.-]\d+)+/g;

/**
 * Punctuation directly between two alphanumeric characters, matched so it
 * can be fused away (no space) when at least one of the two neighbours is
 * a digit. The two alternatives cover digit-before/alnum-after and
 * letter-before/digit-after; a letter on both sides matches neither.
 */
const FUSABLE_PUNCTUATION =
  /(?<=[0-9])[^A-Z0-9\s]+(?=[A-Z0-9])|(?<=[A-Z])[^A-Z0-9\s]+(?=[0-9])/g;

/** Any punctuation left after date-chunk removal and fusion. */
const REMAINING_PUNCTUATION = /[^A-Z0-9\s]+/g;

/** A piece made up of digits only, with nothing else. */
const ALL_DIGITS = /^\d+$/;

/**
 * Applies the four per-token decisions documented on {@link
 * normalizeDescription} and returns the zero or more words this token
 * survives as.
 */
function normalizeToken(token: string): string[] {
  // Decision 1: a token with no letter is a pure number, date, or code.
  if (!HAS_LETTER.test(token)) {
    return [];
  }

  // Decision 2: drop date/cycle-shaped two-group chunks. Replaced with a
  // space (not nothing) so a chunk glued to a word - "Mensalidade-01/2026"
  // - still separates into distinct words instead of fusing back together.
  const withoutDateChunks = token.replace(DIGIT_GROUP_CHAIN, (chunk) =>
    isDateShaped(chunk) ? " " : chunk,
  );

  // Decision 3: fuse punctuation that sits next to a digit.
  const fused = withoutDateChunks.replace(FUSABLE_PUNCTUATION, "");

  // Decision 4: turn every remaining separator into a space, then drop any
  // resulting piece that is purely numeric.
  return fused
    .replace(REMAINING_PUNCTUATION, " ")
    .split(/\s+/)
    .filter((part) => part.length > 0 && !ALL_DIGITS.test(part));
}

/** Exactly two digit groups, at least one of them the four-digit shape of a year. */
function isDateShaped(chunk: string): boolean {
  const groups = chunk.split(/[\/.-]/);
  return groups.length === 2 && groups.some((group) => group.length === 4);
}
