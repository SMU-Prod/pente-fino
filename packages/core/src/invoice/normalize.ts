/**
 * Normalises an invoice line description so the same recurring item matches
 * across issuers and billing cycles (RF-122).
 *
 * ## Definition of a "variable number"
 *
 * RF-122 only says "remoção de números variáveis" without defining what
 * makes a number variable. This is the definition this function implements,
 * written down here so nobody has to reverse-engineer it from the regexes
 * below. A number is variable - and therefore removed - when it is either:
 *
 * 1. Date- or cycle-shaped: a digit group joined by "/", "." or "-" to
 *    another digit group, where the whole match is not immediately
 *    followed by a letter or digit. "01/2026", "07-2026" and "2026.07" are
 *    variable this way. "4.5G" is NOT, because a letter ("G") immediately
 *    follows the digit-group match.
 * 2. Standalone: a digit run with no letter adjacent on either side, once
 *    punctuation fusion (see below) has run. "07", "40041" and "30" are
 *    variable this way.
 *
 * Everything else survives - including a digit run glued to a letter by
 * punctuation, such as "4-G" or "10-GB" - because that shape is a product
 * code or a data tier, not a cycle reference.
 *
 * ## Order of operations matters
 *
 * Rule 1 (date/cycle-shaped removal) runs first, before any punctuation
 * fusion. If fusion ran first, it would glue a cycle number onto the
 * surrounding word - e.g. "Mensalidade-01/2026" would fuse into
 * "MENSALIDADE012026" - and the standalone check (rule 2) could no longer
 * see it as a bare number, since it would no longer have a letter-free
 * boundary on either side. The recurring line would then fail to match
 * itself across billing cycles, which is the entire purpose of this
 * function. Removing the cycle-shaped number before fusion keeps the two
 * rules from fighting each other.
 *
 * ## Punctuation fusion
 *
 * Once cycle/date-shaped numbers are gone, punctuation between two
 * alphanumeric characters fuses - vanishes with no space inserted -
 * whenever at least one of the two neighbours is a digit: "4.5G" (digit,
 * digit) becomes "45G", "4-G" (digit, letter) becomes "4G", and "10-GB"
 * (digit, letter) becomes "10GB", each kept distinct from the plain form it
 * could otherwise collapse into ("4G", "5G", "20-GB"). Punctuation between
 * two letters - e.g. the "(" in "ADICIONADO(SVA)" - is unaffected by fusion
 * and still becomes a space, as does punctuation anywhere else (string
 * edges, next to whitespace, etc.).
 *
 * ## Known limitation
 *
 * A standalone purely numeric token - no punctuation, no adjacent letter -
 * is always dropped by rule 2, so it is indistinguishable from a cycle
 * number: a premium short code like "40041" versus "40042", or "Multa por
 * atraso 30 dias" versus "15 dias", normalise identically. This function
 * has no way to tell an identifier apart from a billing cycle without more
 * context than a string carries. Anything in E2 that matches pattern rules
 * against this output must not assume that equal normalised descriptions
 * mean the same billable item.
 */
export function normalizeDescription(input: string): string {
  return (
    input
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      // Rule 1 (date/cycle-shaped numbers): digit groups joined by / . or -
      // to another digit group, dropped unless a letter or digit
      // immediately follows the whole match. Must run before fusion below
      // (see "Order of operations matters").
      .replace(/\d+(?:[\/.-]\d+)+(?![A-Z0-9])/g, "")
      // Fusion: punctuation between two alphanumerics vanishes (no space)
      // when at least one neighbour is a digit, so "4-G" survives as "4G"
      // and "4.5G" survives as "45G", each distinct from "5G".
      .replace(/(?<=[0-9])[^A-Z0-9\s]+(?=[A-Z0-9])|(?<=[A-Z])[^A-Z0-9\s]+(?=[0-9])/g, "")
      // Everything else non-alphanumeric becomes a space (word separator).
      .replace(/[^A-Z0-9\s]/g, " ")
      // Rule 2 (standalone numbers): digit runs with no adjacent letter.
      .replace(/(?<![A-Z0-9])\d+(?![A-Z0-9])/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}
