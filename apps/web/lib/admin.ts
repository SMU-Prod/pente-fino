import { cookies } from "next/headers";
// eslint-disable-next-line pentefino/require-with-user -- adminAccount (Task 2, packages/db/src/admin.ts) is the admin identity gate itself: it takes a userId already resolved from a signed session and has no per-user data to scope by withUser. resolveSession is separately allowlisted for the same session-resolution every route already does.
import { adminAccount, resolveSession, type Database } from "@pentefino/db";
import { SESSION_COOKIE, getSessionSecret, readSession } from "./session.js";

export type AdminActor = { userId: string; email: string };

/**
 * Splits `ADMIN_EMAILS` on commas and/or whitespace, trims each entry,
 * lower-cases it, and drops anything empty. `undefined` or `""` come back as
 * an empty set — never as a set containing an empty string — so the "is the
 * roster configured at all" check in `requireAdmin` is just `.size === 0`.
 */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const emails = raw
    .split(/[,\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  return new Set(emails);
}

/**
 * RF-300's "acesso restrito por papel" gate, and today's entire role model —
 * this schema has no `role` column and no `admins` table, so this function
 * *is* the role model. An admin is whoever, on the request this call is
 * made for:
 *
 *   (a) presents a `pf_session` cookie whose HMAC verifies
 *       (`readSession`/`getSessionSecret`, `./session.ts`) — a missing,
 *       malformed, or tampered cookie fails here;
 *   (b) whose session `resolveSession` (`@pentefino/db`) resolves to a real
 *       `userId`, not a bare `sessionId` — i.e. a session RF-147's e-mailed
 *       six-digit code has actually claimed, so the e-mail address below is
 *       proven by possession of that mailbox, not merely typed into a form;
 *   (c) whose `users` row is not soft-deleted (`adminAccount`,
 *       `packages/db/src/admin.ts`, returns `null` for a missing or
 *       `deletedAt`-set row);
 *   (d) whose e-mail — compared trimmed and lower-cased on both sides —
 *       appears in the `ADMIN_EMAILS` environment variable.
 *
 * The roster lives in the environment, not in a table: no row this
 * application ever writes, and no row an attacker could get it to write, can
 * make (d) true. Only whoever can set environment variables on the
 * deployment can grant or revoke admin status.
 *
 * **Fails closed, in every direction, with no exception.** With
 * `ADMIN_EMAILS` unset or empty, this returns `null` for absolutely
 * everyone, including a real, logged-in, otherwise-legitimate user — there
 * is no "first user becomes admin" fallback, no `NODE_ENV !== "production"`
 * bypass, and no localhost exemption. Every failure above — no cookie, a
 * wrongly-signed cookie, an unclaimed session, an unlisted e-mail, a
 * soft-deleted account, or no roster configured at all — returns the exact
 * same `null`. The caller can never distinguish which one occurred, on
 * purpose: nothing here should ever tempt a caller into treating one kind of
 * rejection as safer to relax than another.
 *
 * **What this does not protect against**, stated plainly rather than
 * reassuringly:
 *   - A stolen or leaked `pf_session` cookie belonging to an already-admin
 *     account. Whoever holds a valid signed cookie for an allowlisted,
 *     claimed session passes every check here — this function has no way to
 *     tell a legitimate holder of that cookie from someone who copied it.
 *   - A compromised admin mailbox. RF-147's claim code is e-mailed as a
 *     plain six-digit code; anyone who can read that inbox can claim the
 *     session themselves and pass check (b) as that admin.
 *   - Anyone who can set environment variables on the deployment. Editing
 *     `ADMIN_EMAILS` is the *only* way admin status is granted or revoked,
 *     so whoever controls the deploy environment controls the roster
 *     completely.
 *
 * **What this does survive:** anything an attacker can write to the
 * database. No `INSERT` or `UPDATE` — against `users` or any other table —
 * can satisfy check (d), because the roster is never read from a row; it is
 * parsed fresh, each call, from `process.env.ADMIN_EMAILS`.
 *
 * `getSessionSecret()` is the one call in here that can throw instead of
 * folding into this function's `null`-only contract, and that is
 * deliberate: it throws only when `SESSION_SIGNING_SECRET` is unset in
 * production (see its own doc comment in `./session.ts`), which is a
 * boot-time misconfiguration, not a per-request authorization outcome.
 * Every other route in this app (`apps/web/app/api/cases/route.ts`) lets
 * that same throw surface rather than swallowing it, and this function
 * follows that precedent instead of quietly downgrading a missing secret in
 * production to an ordinary "not an admin" rejection.
 */
export async function requireAdmin(db: Database): Promise<AdminActor | null> {
  const allowlist = parseAdminEmails(process.env.ADMIN_EMAILS);
  if (allowlist.size === 0) return null;

  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return null;

  const session = await resolveSession(sessionId, db);
  if (!("userId" in session)) return null;

  const account = await adminAccount(db, session.userId);
  if (!account) return null;

  const email = account.email.trim().toLowerCase();
  if (!allowlist.has(email)) return null;

  return { userId: account.id, email };
}
