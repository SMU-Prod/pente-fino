import type { InvoiceCanonical } from "../../invoice/canonical.js";
import type { ActiveRule } from "../engine.js";
import type { Finding } from "../finding.js";
import type { ReferenceFlag, ReferenceTariff } from "../references.js";

/**
 * The external reference data an evaluator may compare an invoice against
 * (RN-040/RN-041). Same shape as `RuleEngineInput.references` in
 * `../engine.ts` — the engine (E2 Task 4) passes its own `references`
 * field straight through when it builds each `EvaluationContext`.
 */
export type References = {
  tariffs: ReferenceTariff[];
  flags: ReferenceFlag[];
};

/**
 * Everything an evaluator is allowed to read. Deliberately narrower than
 * `RuleEngineInput`: no `rules` (an evaluator judges the one rule it is
 * called with) and no I/O — every field is data already resolved by the
 * caller, per RF-120.
 */
export type EvaluationContext = {
  invoice: InvoiceCanonical;
  previous: InvoiceCanonical | null;
  references: References;
  answers: Record<string, string>;
};

/**
 * One evaluator per `RuleSpec` kind. Pure function: the rule and the
 * context in, zero or more findings out. RF-129 binds every evaluator:
 * a finding's `evidence` and `legalBasis` must come from the rule and the
 * data in `ctx`, never invented.
 */
export type Evaluator = (rule: ActiveRule, ctx: EvaluationContext) => Finding[];
