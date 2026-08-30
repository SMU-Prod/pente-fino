import type { InvoiceCanonical } from "../invoice/canonical.js";
import type { Finding } from "./finding.js";
import type { RuleSpec } from "./spec.js";

export type ActiveRule = {
  slug: string;
  version: number;
  spec: RuleSpec;
  confidenceBase: number;
  shadow: boolean;
};

export type RuleEngineInput = {
  invoice: InvoiceCanonical;
  previous: InvoiceCanonical | null;
  rules: ActiveRule[];
  answers: Record<string, string>;
};

/**
 * Evaluates every active rule over an invoice (RF-120). Pure: no I/O, and
 * the same input always yields the same output.
 *
 * E0 ships the boundary only. The seven evaluators of RF-121 arrive in E2,
 * and until then an empty rule set produces an empty finding list — the
 * engine does not pretend to judge.
 */
export function runRules(input: RuleEngineInput): Finding[] {
  if (input.rules.length === 0) return [];
  const rules = input.rules.map((rule) => `${rule.slug}@${rule.version}`).join(", ");
  throw new Error(`rule evaluators are not implemented yet (E2): rules=[${rules}]`);
}
