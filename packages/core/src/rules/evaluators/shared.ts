import type { LegalRef } from "../spec.js";

/**
 * Formats integer cents as a pt-BR money string ("R$ 1.234,56") without
 * `Intl`/locale support, whose availability differs between the Windows
 * dev machine and Linux CI this project targets. Pure integer arithmetic
 * throughout - never divides by 100 into a float before formatting - so
 * there is no floating-point rounding risk here either.
 */
export function formatCentsBRL(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const reais = Math.trunc(abs / 100);
  const centavos = abs % 100;
  const reaisWithSeparators = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${reaisWithSeparators},${centavos.toString().padStart(2, "0")}`;
}

/**
 * RF-129: `doubledCents` is derived from the rule's own `legalBasis`, never
 * invented by an evaluator. When any citation's `effect` is `"dobro"` (CDC
 * art. 42 p.u. and similar "pay back double" norms), the amount doubles;
 * otherwise doubling is left `null` rather than defaulting to a guess.
 */
export function computeDoubledCents(amountCents: number, legalBasis: LegalRef[]): number | null {
  return legalBasis.some((ref) => ref.effect === "dobro") ? amountCents * 2 : null;
}

/** Natural-Portuguese phrasing for a threshold operator, for evidence text. */
export function operatorPhrase(operator: ">" | "<" | ">=" | "<="): string {
  switch (operator) {
    case ">":
      return "acima de";
    case "<":
      return "abaixo de";
    case ">=":
      return "igual ou acima de";
    case "<=":
      return "igual ou abaixo de";
  }
}
