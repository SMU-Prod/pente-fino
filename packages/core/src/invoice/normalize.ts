/**
 * Normalises an invoice line description so the same item matches across
 * issuers and cycles (RF-122).
 *
 * Standalone numbers are dropped because they carry the cycle, not the
 * item: "Pacote 07/2026" and "Pacote 08/2026" are the same line. Digits
 * glued to letters survive, because "4G" is part of the name.
 */
export function normalizeDescription(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/(?<![A-Z0-9])\d+(?![A-Z0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
