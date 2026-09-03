// Only the `schema` namespace object is exported, never the tables it
// holds by name (INV-008, Blocker C1 / Bypass 2): a bare `export * from
// "./schema.js"` used to re-export all twenty tables individually, and no
// fixed list of forbidden names in the eslint rule could keep up with that
// short of enumerating every one of them. Anything outside packages/db that
// needs a table reaches it through `schema.<table>`, which the
// `require-with-user` rule already blocks from the package entry.
export * as schema from "./schema.js";
export { getUnscopedDb, type Database } from "./client.js";
export { withUser, ensureAnonymousSession, resolveSession, type Session, type ScopedDb } from "./with-user.js";
// Deliberately NOT behind `withUser` (INV-008 is about a user's query
// reaching another user's data; these have no session and no caller-supplied
// id). E5 Task 5 exists so RF-186's day-60 abandonment sweep can close a
// case *and settle its findings* in one transaction: `closeCase` was the
// only code that moved a finding out of `contested`, and being a `withUser`
// method it was unreachable from a job — which would have left every
// system-closed case's findings shown on the report as a live dispute and
// permanently barred from a new case. See `case-close.ts`.
export { closeCaseAsSystem, settleCaseFindings, SETTLED_FINDING_STATUS } from "./case-close.js";
// E6 Task 3's other system write, for the opposite transition: RF-203
// reopens a case `closeCaseAsSystem` (or `closeCase`) already closed, once
// Task 4's job finds the disputed charge back on invoice N+2. Same shape as
// `closeCaseAsSystem` for the same reason - no session, a case id the
// caller already read out of `cases`. See `case-reopen.ts`.
export { reopenCase } from "./case-reopen.js";
// RF-204's public metric. Not yet on `require-with-user.js`'s
// ALLOWED_PACKAGE_EXPORTS: nothing outside packages/db imports it as of this
// task, and the same rule the seeds re-exports below follow applies here -
// exporting it from this package's entry point does not by itself let a
// caller outside packages/db past the lint gate. Whoever builds the first
// consumer (an admin dashboard, say) adds its own name to that allowlist
// then, with its own justification.
export { confirmedRecoveredCents } from "./metrics.js";
// RF-245 (Task 2, E8), the same shape of exception as `closeCaseAsSystem`
// just above: a future aggregation job has no user session to scope to, and
// this hands out no raw data access of its own — every row it returns is
// gated on the owning `users` row's own consent, decided inside the query
// itself rather than left for a caller to remember. See `aggregation.ts`.
export { invoicesEligibleForAggregation } from "./aggregation.js";
export {
  requestClaimCode, confirmClaimCode,
  CLAIM_CODE_TTL_MS, CLAIM_CODE_MAX_ATTEMPTS, CLAIM_RATE_LIMIT_COUNT, CLAIM_RATE_LIMIT_WINDOW_MS,
} from "./claim.js";
// E11 Task 2: the admin panel's data layer. Also not behind `withUser` — the
// same reasoning as `closeCaseAsSystem` above, one level removed: rules,
// proposals and the overview counters are system configuration, not one
// user's data, so there is no session to scope any of these to. See
// `admin.ts`'s own header for the two invariants (append-only rule content,
// single promotion path) that hold across every function here.
export {
  RuleDraftError, adminAccount, createRuleVersion, activateRuleVersion, pauseRuleVersion,
  listRuleFamilies, listProposals, rejectProposal, adminOverview,
  type CreateRuleVersionResult, type ActivateRuleVersionInput, type PauseRuleVersionInput,
  type RuleVersionMetrics, type RuleFamilyVersion, type RuleFamily,
  type ProposalRow, type RejectProposalInput, type AdminOverview,
} from "./admin.js";
// Exported for a future deploy/ops seeding step against the real database;
// `testing.ts` calls `seedAll` directly from `./seeds/index.js` and does not
// need this re-export. A caller outside packages/db still has to add its own
// name to require-with-user.js's ALLOWED_PACKAGE_EXPORTS (INV-008) before
// this import stops tripping the lint rule — these three are not on that
// list yet, since nothing outside this package calls them today.
export { seedAll, seedIssuers, seedPrompts } from "./seeds/index.js";
