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
// Exported for a future deploy/ops seeding step against the real database;
// `testing.ts` calls `seedAll` directly from `./seeds/index.js` and does not
// need this re-export. A caller outside packages/db still has to add its own
// name to require-with-user.js's ALLOWED_PACKAGE_EXPORTS (INV-008) before
// this import stops tripping the lint rule — these three are not on that
// list yet, since nothing outside this package calls them today.
export { seedAll, seedIssuers, seedPrompts } from "./seeds/index.js";
