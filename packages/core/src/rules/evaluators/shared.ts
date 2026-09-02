import type { LegalRef } from "../spec.js";

// `formatCentsBRL` now lives in `packages/core/src/format.ts`, the single
// home for money and date formatting in this monorepo — RF-187 found two
// private copies of it disagreeing about the same number on the same page.
// Re-exported here so every existing caller of this module is unaffected.
export { formatCentsBRL } from "../../format.js";

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
