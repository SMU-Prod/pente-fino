import type { InvoiceCanonical } from "../invoice/canonical.js";
import type { Finding } from "./finding.js";
import type { ReferenceFlag, ReferenceTariff } from "./references.js";
import type { LegalRef, RuleSpec } from "./spec.js";

export type ActiveRule = {
  slug: string;
  version: number;
  spec: RuleSpec;
  confidenceBase: number;
  shadow: boolean;
  // RF-129/RF-161: every finding this rule produces must carry at least one
  // of these — the model never supplies legalBasis, only the fired rule does.
  legalBasis: LegalRef[];
  // RF-123: null means the generic rule for `slug`. A non-null issuerId
  // outranks the generic rule of the same slug, resolved inside the engine
  // rather than depending on how the caller happened to query `rules`.
  issuerId: string | null;
};

export type RuleEngineInput = {
  invoice: InvoiceCanonical;
  previous: InvoiceCanonical | null;
  rules: ActiveRule[];
  answers: Record<string, string>;
  // RN-040/RN-041: ANEEL tariff and flag tables. External data the engine
  // cannot derive from the invoices itself, so it arrives as an argument —
  // RF-120 requires the engine to stay free of I/O.
  references: {
    tariffs: ReferenceTariff[];
    flags: ReferenceFlag[];
  };
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
