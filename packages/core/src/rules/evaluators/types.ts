import type { InvoiceCanonical } from "../../invoice/canonical.js";
import type { ActiveRule } from "../engine.js";
import type { Finding } from "../finding.js";
import type { ReferenceFlag, ReferenceTariff } from "../references.js";

/**
 * External reference data an evaluator may compare against (RN-040/041's
 * ANEEL tables, RN-100's CDC limits in later evaluators). Named separately
 * from `RuleEngineInput`'s inline shape in `engine.ts` so evaluator modules
 * do not need to import the engine's input type just to describe their own
 * context - the two are structurally identical by construction.
 */
export type References = {
  tariffs: ReferenceTariff[];
  flags: ReferenceFlag[];
};

/**
 * Everything an evaluator is allowed to read (RF-120). Deliberately closed:
 * no database handle, no clock, no network - if a rule needs a fact that
 * is not one of these four things, it cannot be expressed as an evaluator
 * without first threading that fact through here.
 */
export type EvaluationContext = {
  invoice: InvoiceCanonical;
  previous: InvoiceCanonical | null;
  references: References;
  answers: Record<string, string>;
};

/**
 * One evaluator per `RuleSpec` kind (RF-121). Each evaluator narrows
 * `rule.spec` to its own kind at runtime (see the per-kind modules) and
 * throws if the engine ever routes it the wrong kind of rule - a routing
 * bug, not a data problem, so it must be loud rather than silently
 * producing no findings.
 */
export type Evaluator = (rule: ActiveRule, ctx: EvaluationContext) => Finding[];
