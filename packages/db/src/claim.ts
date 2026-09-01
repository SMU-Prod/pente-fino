import { createHmac, randomInt } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { getUnscopedDb } from "./client.js";
import { anonymousSessions, claimCodes, events, invoices, users } from "./schema.js";

type Db = ReturnType<typeof getUnscopedDb>;

/**
 * RF-147's credential, and the three decisions that make it one instead of
 * a bare shared secret:
 *
 *   - Lifetime: 15 minutes (`CLAIM_CODE_TTL_MS`). Long enough to survive
 *     real-world mail delivery lag, short enough that a code sitting unused
 *     in an inbox (or in this adapter's .eml file - see
 *     packages/adapters/src/mailer/local.ts) stops being usable well before
 *     someone else could plausibly find it.
 *   - Attempts: 5 wrong guesses and the code is dead (`CLAIM_CODE_MAX_ATTEMPTS`),
 *     even if the 6th guess would have been right. A 6-digit code has
 *     1,000,000 possible values; 5 guesses caps blind brute force at a
 *     0.0005% chance per code, and a dead code forces a fresh
 *     `requestClaimCode` call - which is where the real cost (§8.3's
 *     3-per-hour limit, one real e-mail sent) lives.
 *   - Single-use: yes. `confirmClaimCode` marks the row `consumedAt` the
 *     moment it succeeds. A second confirmation with the *same* code is
 *     detected (the `row.consumedAt` branch below) and replays the same
 *     success instead of erroring or re-running the migration a second,
 *     dangerous way - it is `migrate`'s own idempotency (see its doc
 *     comment) that actually makes the replay safe, not a flag on this row.
 *   - Storage: never the plaintext code. `hashCode` below is an
 *     HMAC-SHA256 of the code, keyed with a secret the caller supplies and
 *     that this module never persists - a database dump alone hands over
 *     1,000,000 equally-likely hashes and nothing to test them against, the
 *     same property a salted password hash has over a plaintext one. Plain
 *     SHA-256 (or any unkeyed hash) would not be enough here the way it
 *     would for a long random token: a 6-digit code's entire keyspace is
 *     small enough to hash-and-compare offline in well under a second, so
 *     the secret is load-bearing, not a formality.
 */
export const CLAIM_CODE_TTL_MS = 15 * 60 * 1000;
export const CLAIM_CODE_MAX_ATTEMPTS = 5;

/** PRD §8.3, verbatim: 3 sends per e-mail address per hour. */
export const CLAIM_RATE_LIMIT_COUNT = 3;
export const CLAIM_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code).digest("hex");
}

export type RequestClaimCodeResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; reason: "rate_limited"; retryAfterMs: number };

/**
 * PRD §8.3's limit is keyed by e-mail alone, deliberately, not by session or
 * IP: this route sends real mail to an address the caller merely asserts,
 * so the party it protects is the recipient, not the caller. Rotating
 * anonymous sessions (or IPs) buys an attacker nothing - the count below
 * only ever looks at `claim_codes.email`. A genuine retry (someone who
 * simply never received the first mail) is not distinguished from a
 * malicious one, and does not need to be: it draws from the same
 * three-per-hour budget as anyone else touching that address, which is
 * exactly enough for a person to notice a mail did not arrive and ask for
 * another, without ever approaching what an attacker would need. Wrong
 * *code* guesses on `confirmClaimCode` never touch this counter at all -
 * that is a fully independent budget (`CLAIM_CODE_MAX_ATTEMPTS`), so
 * mistyping a received code cannot burn through the sends this limit
 * protects.
 *
 * The read and the insert run inside one transaction so two requests racing
 * for the same email cannot both observe "2 sent so far" and both insert a
 * third and fourth. This is best-effort, not airtight: Postgres's default
 * READ COMMITTED isolation does not itself block a second, truly concurrent
 * transaction from doing the same read before the first commits its
 * insert - closing that completely would need `SERIALIZABLE` isolation or
 * an explicit per-email lock, which is more than this abuse-mitigation
 * needs on a first cut.
 */
export async function requestClaimCode(
  input: { email: string; sessionId: string; secret: string },
  db: Db = getUnscopedDb(),
): Promise<RequestClaimCodeResult> {
  const email = normalizeEmail(input.email);

  return db.transaction(async (tx) => {
    const windowStart = new Date(Date.now() - CLAIM_RATE_LIMIT_WINDOW_MS);
    const recent = await tx.select({ createdAt: claimCodes.createdAt }).from(claimCodes)
      .where(and(eq(claimCodes.email, email), gt(claimCodes.createdAt, windowStart)))
      .orderBy(claimCodes.createdAt);

    if (recent.length >= CLAIM_RATE_LIMIT_COUNT) {
      const oldest = recent[0]!.createdAt;
      const retryAfterMs = Math.max(oldest.getTime() + CLAIM_RATE_LIMIT_WINDOW_MS - Date.now(), 0);
      return { ok: false, reason: "rate_limited", retryAfterMs };
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CLAIM_CODE_TTL_MS);
    await tx.insert(claimCodes).values({
      id: newId("clm"),
      email,
      sessionId: input.sessionId,
      codeHash: hashCode(code, input.secret),
      expiresAt,
    });

    return { ok: true, code, expiresAt };
  });
}

export type ConfirmClaimCodeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" };

async function findOrCreateUser(tx: Db, email: string) {
  const id = newId("usr");
  // Same idempotent-insert idiom as `ensureAnonymousSession`: races on
  // `users.email`'s unique constraint resolve to "someone already exists",
  // never an error - which is exactly what lets two anonymous sessions
  // (e.g. the same person's phone and laptop) both claim the same e-mail
  // and land on one shared user instead of colliding.
  await tx.insert(users).values({ id, email }).onConflictDoNothing({ target: users.email });
  const [user] = await tx.select().from(users).where(eq(users.email, email));
  return user!;
}

/**
 * The actual migration (RF-147's "sem perda de achados"). `invoice_items`
 * and `findings` are never touched directly here: neither carries a
 * `user_id` or `session_id` column of its own (see schema.ts) - both hang
 * off `invoices.id` through a `references(..., { onDelete: "cascade" })`
 * foreign key, so re-pointing the *invoice* row in place is the whole
 * migration for everything under it. The one way to lose a finding here
 * would be to delete-and-reinsert the invoice instead of updating it -
 * cascading straight through both children - which is exactly what the
 * common path below does not do.
 *
 * `cases` is deliberately left alone: `cases.userId` is NOT NULL, and
 * `withUser().cases()` already returns nothing for an anonymous caller
 * (packages/db/src/with-user.ts) - under every path this app exposes today,
 * a case cannot exist yet for an invoice still owned by a bare session, so
 * there is nothing to re-point. (No `/api/cases` route exists yet either -
 * E4 is a later block.)
 *
 * The one real hazard: the target user may already own an invoice with the
 * same content hash - they uploaded the identical file once anonymously and
 * once already signed in. `invoices_owner_hash` is a unique index on
 * `coalesce(user_id, session_id), content_hash`, so re-pointing the
 * anonymous copy straight to this user would collide with the copy the
 * user already has. Since a matching hash means it is bit-for-bit the same
 * file, nothing is lost by keeping the user's existing copy as
 * authoritative and dropping the anonymous duplicate instead - its own
 * extraction already covers the identical content - and the drop is
 * recorded on the `session_claimed` event's payload for anyone auditing the
 * migration later.
 *
 * Idempotent by construction, not by a special-cased "already done" branch:
 * every write here keys off `sessionId`, and the first successful run
 * already clears it from every invoice and event that had it - a second
 * run's `WHERE session_id = ?` (or `WHERE id = anonymousSessionId`, for the
 * `anonymous_sessions` update) simply finds nothing left to change. Calling
 * this twice for the same session is exactly what a double-submitted
 * confirmation does (see `confirmClaimCode`'s `consumedAt` branch), so this
 * property is load-bearing, not incidental.
 */
async function migrate(tx: Db, email: string, sessionId: string): Promise<string> {
  const user = await findOrCreateUser(tx, email);

  const sessionInvoices = await tx.select({ id: invoices.id, contentHash: invoices.contentHash })
    .from(invoices).where(eq(invoices.sessionId, sessionId));
  const ownedHashes = new Set(
    (await tx.select({ contentHash: invoices.contentHash }).from(invoices).where(eq(invoices.userId, user.id)))
      .map((row) => row.contentHash),
  );

  const toMigrate = sessionInvoices.filter((row) => !ownedHashes.has(row.contentHash)).map((row) => row.id);
  const toDrop = sessionInvoices.filter((row) => ownedHashes.has(row.contentHash)).map((row) => row.id);

  if (toMigrate.length > 0) {
    await tx.update(invoices).set({ userId: user.id, sessionId: null }).where(inArray(invoices.id, toMigrate));
  }
  if (toDrop.length > 0) {
    // findings/invoice_items cascade with this delete (onDelete: "cascade")
    // - safe here specifically because the content is a proven duplicate of
    // a row the user keeps; see the doc comment above.
    await tx.delete(invoices).where(inArray(invoices.id, toDrop));
  }

  await tx.update(events).set({ userId: user.id, sessionId: null }).where(eq(events.sessionId, sessionId));
  await tx.update(anonymousSessions).set({ claimedByUserId: user.id }).where(eq(anonymousSessions.id, sessionId));
  await tx.insert(events).values({
    id: newId("evt"),
    userId: user.id,
    type: "session_claimed",
    payload: { claimedSessionId: sessionId, mergedDuplicateInvoiceIds: toDrop },
  });

  return user.id;
}

/**
 * INV-008: scoping the lookup by `sessionId` (not just `email`) means a code
 * issued for one anonymous session can never be redeemed under a different
 * one, even by someone who correctly guesses (or otherwise learns) the
 * digits - `confirmClaimCode` called with the right email and code but the
 * wrong `sessionId` finds no row at all (the same outcome as a code that
 * was never requested), not a "wrong session" error that would confirm a
 * code exists for that email.
 */
export async function confirmClaimCode(
  input: { email: string; code: string; sessionId: string; secret: string },
  db: Db = getUnscopedDb(),
): Promise<ConfirmClaimCodeResult> {
  const email = normalizeEmail(input.email);
  const codeHash = hashCode(input.code, input.secret);

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(claimCodes)
      .where(and(eq(claimCodes.email, email), eq(claimCodes.sessionId, input.sessionId)))
      .orderBy(desc(claimCodes.createdAt))
      .limit(1);

    if (!row) return { ok: false, reason: "invalid" };

    // A second confirmation of a code that already succeeded once: safe to
    // retry means this must succeed again, not error - and, having already
    // moved everything the first time, it should write nothing further.
    // `consumedAt` and `migrate`'s writes commit together in this same
    // transaction (see below), so reaching this branch guarantees
    // `anonymous_sessions.claimed_by_user_id` is already set - reading it
    // back is enough; there is no need to re-run `migrate` (which *would*
    // be safe to repeat - see its own doc comment - but would also insert a
    // second, redundant `session_claimed` event for no reason).
    if (row.consumedAt) {
      if (row.codeHash !== codeHash) return { ok: false, reason: "invalid" };
      const [session] = await tx.select({ claimedByUserId: anonymousSessions.claimedByUserId })
        .from(anonymousSessions).where(eq(anonymousSessions.id, input.sessionId));
      if (!session?.claimedByUserId) return { ok: false, reason: "invalid" }; // defensive; unreachable in practice
      return { ok: true, userId: session.claimedByUserId };
    }

    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "invalid" };
    if (row.attempts >= CLAIM_CODE_MAX_ATTEMPTS) return { ok: false, reason: "invalid" };

    if (row.codeHash !== codeHash) {
      await tx.update(claimCodes)
        .set({ attempts: sql`${claimCodes.attempts} + 1` })
        .where(eq(claimCodes.id, row.id));
      return { ok: false, reason: "invalid" };
    }

    await tx.update(claimCodes).set({ consumedAt: new Date() }).where(eq(claimCodes.id, row.id));
    const userId = await migrate(tx, email, input.sessionId);
    return { ok: true, userId };
  });
}
