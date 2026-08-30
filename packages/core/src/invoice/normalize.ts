/**
 * Normalises an invoice line description so the same item matches across
 * issuers and cycles (RF-122).
 *
 * Standalone numbers are dropped because they carry the cycle, not the
 * item: "Pacote 07/2026" and "Pacote 08/2026" are the same line. Digits
 * glued to letters survive, because "4G" is part of the name.
 *
 * Punctuation between two alphanumeric characters fuses - vanishes with no
 * replacement, rather than becoming a space - whenever at least one of the
 * two neighbours is a digit: "4.5G" (digit, digit) becomes "45G", "4-G"
 * (digit, letter) becomes "4G", and "10-GB" (digit, letter) becomes "10GB",
 * each kept distinct from the plain form it could otherwise collapse into
 * ("4G", "5G", "20-GB"). "07/2026" (digit, digit) becomes "072026", a pure
 * digit run with no adjacent letter, so it is still dropped as cycle noise.
 * Punctuation between two letters - e.g. the "(" in "ADICIONADO(SVA)" - is
 * unaffected by this rule and still becomes a space, as does punctuation
 * anywhere else.
 *
 * Known limitation: a purely numeric token is always dropped, so two lines
 * that differ only by a standalone number normalise identically - a
 * premium short code like "40041" versus "40042", or "Multa por atraso 30
 * dias" versus "15 dias". A pure normalisation function cannot tell an
 * identifier from a billing cycle apart from context it doesn't have.
 * Anything in E2 that matches pattern rules against this output must not
 * assume that equal normalised descriptions mean the same billable item.
 */
export function normalizeDescription(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/(?<=[0-9])[^A-Z0-9\s]+(?=[A-Z0-9])|(?<=[A-Z])[^A-Z0-9\s]+(?=[0-9])/g, "")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/(?<![A-Z0-9])\d+(?![A-Z0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
