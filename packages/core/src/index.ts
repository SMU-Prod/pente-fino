export { newId, newPublicToken, type IdPrefix } from "./id.js";
export { EVENTS, type EventType } from "./events.js";
export { InvoiceCanonical, CATEGORIES, type Category, type InvoiceItem } from "./invoice/canonical.js";
export { RULE_KINDS, type RuleKind, type RuleSpec, type LegalRef } from "./rules/spec.js";
export type { Finding } from "./rules/finding.js";
export { STAGES, type Stage, type Playbook } from "./cases/playbook.js";
export { ContestDocument } from "./documents/contest.js";
export {
  assembleContest, MANDATORY_SCRIPT_ITEMS,
  type AssembleContestInput, type AssembledContest, type RecordedProtocol,
} from "./documents/assemble.js";
export {
  buildDossier, DOSSIER_FIXED_STRINGS,
  type BuildDossierInput, type Dossier, type DossierEntry, type DossierEntryKind,
  type DossierAttachment, type DossierAttachmentStatus, type DossierParty,
} from "./documents/dossier.js";
// Exported for `apps/jobs`'s PDF renderer, which prints the same invoice
// total and the same dates this package's dossier model already formatted -
// on the same page. A private second copy there is what made `R$ 1189,90`
// and `R$ 1.189,90` appear on one document (RF-187 review, I5).
export { formatCentsBRL, formatIsoDateOrUnknown, formatUtcDate } from "./format.js";
export { normalizeDescription } from "./invoice/normalize.js";
export { validateInvoice, type ValidationResult, type ValidationFailure } from "./invoice/validate.js";
export { maskCanonical, maskText, containsPii, CNPJ_SHAPE_SOURCE } from "./invoice/mask.js";
export { runRules, type ActiveRule, type RuleEngineInput } from "./rules/engine.js";
// A `rules.spec.match`/`notMatch` string is admin-edited configuration
// (`safe-regex.ts`'s own doc comment) seeded from outside this package —
// packages/db's seed files are exactly that kind of caller. Exported so
// whoever writes a `pattern` RuleSpec can verify it is safe (and, via
// `compileSafePattern`, that it actually matches what they intend) before
// it ever reaches a `rules` row, instead of only being checkable from
// inside `packages/core` itself.
export {
  assertSafePattern, compileSafePattern, UnsafePatternError,
} from "./rules/evaluators/safe-regex.js";
export { TARIFF_FLAGS, type TariffFlag, type ReferenceTariff, type ReferenceFlag } from "./rules/references.js";
export {
  nextStage, CASE_OUTCOMES,
  type StageEvent, type StageTransition, type CaseOutcome,
} from "./cases/next-stage.js";
export { pairInvoiceItems, type InvoiceDiff, type PairedItem } from "./diff/index.js";
export {
  extractionQuality, VISION_THRESHOLD,
  type QualityScore, type Anchor,
} from "./invoice/extraction-quality.js";
export {
  detectIssuer,
  type IssuerCandidate, type IssuerMatch,
} from "./invoice/detect-issuer.js";
export {
  sniffMimeType, MAX_PAGES,
  type SniffedType,
} from "./invoice/file-gate.js";
