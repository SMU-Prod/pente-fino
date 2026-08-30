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
