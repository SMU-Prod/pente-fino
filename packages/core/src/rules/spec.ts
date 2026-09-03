export type LegalRef = {
  law: string;
  article: string;
  effect: "dobro" | "suspensao" | "cancelamento" | "amostra_gratis" | "vedada" | "limite";
  note?: string;
};

export type RuleSpec =
  | { kind: "pattern"; sections?: string[]; match: string; notMatch?: string;
      valueRange?: [number, number]; requireRecurrence?: number }
  | { kind: "delta"; field: "item_present" | "amount" | "section_total";
      comparedTo: "previous_invoice"; changeAtLeastPct?: number }
  | { kind: "threshold"; expr: string; operator: ">" | "<" | ">=" | "<="; value: number }
  | { kind: "reference"; source: "aneel_tariff" | "aneel_flag" | "cdc_limits";
      tolerancePct: number }
  | { kind: "confirm"; question: string; options: string[]; onNo: "create_finding" }
  | { kind: "arithmetic"; formula: string; expect: string; tolerancePct: number }
  | { kind: "suppressor"; blocks: string[]; reason: string };

export const RULE_KINDS = [
  "pattern", "delta", "threshold", "reference", "confirm", "arithmetic", "suppressor",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/**
 * Compile-time proof that RULE_KINDS covers exactly the `kind` discriminants of
 * RuleSpec — no fewer, no more. `AssertEqual` performs the bidirectional
 * `extends` check (each union must be assignable to the other), and asserting
 * it against a `const` turns any drift between the union and the array into a
 * `tsc` error instead of a silent runtime gap.
 */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _ruleKindsCoverRuleSpecExactly: AssertEqual<RuleKind, RuleSpec["kind"]> = true;
void _ruleKindsCoverRuleSpecExactly;

/**
 * `LegalRef["effect"]`'s six literals, mirrored as a runtime array the same
 * way `RULE_KINDS` mirrors `RuleSpec["kind"]` above — `validateRuleDraft`
 * (`draft.ts`) needs an array to check an admin-submitted `effect` string
 * against, and `LegalRef` itself has no runtime representation to read that
 * from. The `AssertEqual` check below is what keeps the two from silently
 * drifting apart the moment a seventh `effect` is added to one but not the
 * other.
 */
export const LEGAL_REF_EFFECTS = [
  "dobro", "suspensao", "cancelamento", "amostra_gratis", "vedada", "limite",
] as const;
export type LegalRefEffect = (typeof LEGAL_REF_EFFECTS)[number];

const _legalRefEffectsCoverExactly: AssertEqual<LegalRefEffect, LegalRef["effect"]> = true;
void _legalRefEffectsCoverExactly;
