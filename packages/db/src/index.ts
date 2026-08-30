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
