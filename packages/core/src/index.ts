export { newId, newPublicToken, type IdPrefix } from "./id.js";
export { EVENTS, type EventType } from "./events.js";
export { InvoiceCanonical, CATEGORIES, type Category, type InvoiceItem } from "./invoice/canonical.js";
export { RULE_KINDS, type RuleKind, type RuleSpec, type LegalRef } from "./rules/spec.js";
export type { Finding } from "./rules/finding.js";
export { STAGES, type Stage, type Playbook } from "./cases/playbook.js";
export { ContestDocument } from "./documents/contest.js";
export {
  assembleContest, collectExpiredDeadlines, expiredDeadlineSentence, MANDATORY_SCRIPT_ITEMS,
  type AssembleContestInput, type AssembledContest, type RecordedProtocol,
  type ExpiredDeadline, type CaseProtocolRecord, type CaseEventRecord,
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
// INV-006's vocabulary, moved here (Task 1, E11) from a test file that could
// only ever catch a seeded rule, never one an admin types into the panel.
// Exported so `validateRuleDraft` below is not the only production caller
// able to reach it — `packages/db`'s own invariant spec imports these same
// three names instead of keeping a second, driftable copy.
export { findSensitiveTerm, stringsIn, SENSITIVE_VOCABULARY } from "./rules/sensitive.js";
// The pure-function gate every admin-authored `rules` row passes through
// before it becomes an INSERT (RF-301). Exported so later E11 tasks' write
// path can call it from `packages/db` without reimplementing any of its
// checks.
export {
  validateRuleDraft,
  type RuleDraftInput, type RuleDraftProblem, type RuleDraftValidation,
} from "./rules/draft.js";
export { TARIFF_FLAGS, type TariffFlag, type ReferenceTariff, type ReferenceFlag } from "./rules/references.js";
export {
  nextStage, CASE_OUTCOMES, STAGE_EVENT_TYPES,
  type StageEvent, type StageTransition, type CaseOutcome,
} from "./cases/next-stage.js";
export {
  easterSunday, nationalHolidays, isBusinessDay, addCivilDays, civilDayOfWeek,
  HOLIDAY_CALENDAR_VERSION, HOLIDAY_CALENDAR_FIRST_YEAR, HOLIDAY_CALENDAR_LAST_YEAR,
  type CivilDate, type NationalHoliday, type HolidayObservance,
} from "./cases/holidays.js";
export {
  computeDeadline, toCivilDate, SAO_PAULO_UTC_OFFSET_MINUTES,
  type Deadline, type DeadlineInput,
} from "./cases/deadline.js";
// RF-186's 30-day window, exported because E5 Task 3's deadline job is what
// has to tell the first window from the second (`nextStage` is not given the
// case's age) and must not restate the number. `decideTransition` and the
// rest of the table stay internal — `nextStage` is the machine's entry.
export { PROTOCOL_WINDOW_DAYS } from "./cases/next-stage.table.js";
// PRD §20.2's reference playbook. Exported because the row it belongs in
// lives outside this package: `packages/db/src/seeds/playbooks.ts` writes it
// onto `issuers.playbook`, the same way `packages/db/src/seeds/prompts.ts`
// writes `@pentefino/ai`'s versioned prompt constants into `prompts`.
export { TELECOM_PLAYBOOK_V1 } from "./cases/telecom-playbook.js";
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
