export { newId, type IdPrefix } from "./id.js";
export { EVENTS, type EventType } from "./events.js";
export { InvoiceCanonical, CATEGORIES, type Category, type InvoiceItem } from "./invoice/canonical.js";
export { RULE_KINDS, type RuleKind, type RuleSpec, type LegalRef } from "./rules/spec.js";
export type { Finding } from "./rules/finding.js";
export { STAGES, type Stage, type Playbook } from "./cases/playbook.js";
export { ContestDocument } from "./documents/contest.js";
export { normalizeDescription } from "./invoice/normalize.js";
export { validateInvoice, type ValidationResult, type ValidationFailure } from "./invoice/validate.js";
export { maskCanonical, maskText, containsPii } from "./invoice/mask.js";
export { runRules, type ActiveRule, type RuleEngineInput } from "./rules/engine.js";
export { TARIFF_FLAGS, type TariffFlag, type ReferenceTariff, type ReferenceFlag } from "./rules/references.js";
export {
  nextStage, CASE_OUTCOMES,
  type StageEvent, type StageTransition, type CaseOutcome,
} from "./cases/next-stage.js";
export { pairInvoiceItems, type InvoiceDiff, type PairedItem } from "./diff/index.js";
