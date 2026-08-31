// Only the `schema` namespace object is exported, never the tables it
// holds by name (INV-008, Blocker C1 / Bypass 2): a bare `export * from
// "./schema.js"` used to re-export all twenty tables individually, and no
// fixed list of forbidden names in the eslint rule could keep up with that
// short of enumerating every one of them. Anything outside packages/db that
// needs a table reaches it through `schema.<table>`, which the
// `require-with-user` rule already blocks from the package entry.
export * as schema from "./schema.js";
export { getUnscopedDb, type Database } from "./client.js";
export { withUser, ensureAnonymousSession, type Session, type ScopedDb } from "./with-user.js";
// Exported for a future deploy/ops seeding step against the real database;
// `testing.ts` calls `seedAll` directly from `./seeds/index.js` and does not
// need this re-export. A caller outside packages/db still has to add its own
// name to require-with-user.js's ALLOWED_PACKAGE_EXPORTS (INV-008) before
// this import stops tripping the lint rule — these three are not on that
// list yet, since nothing outside this package calls them today.
export { seedAll, seedIssuers, seedPrompts } from "./seeds/index.js";
