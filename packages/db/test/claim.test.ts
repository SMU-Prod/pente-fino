import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  anonymousSessions, claimCodes, events, findings, invoiceItems, invoices, issuers, rules, users,
} from "../src/schema.js";
import {
  CLAIM_CODE_MAX_ATTEMPTS, CLAIM_CODE_TTL_MS, CLAIM_RATE_LIMIT_COUNT, CLAIM_RATE_LIMIT_WINDOW_MS,
  confirmClaimCode, requestClaimCode,
} from "../src/claim.js";

const SECRET = "claim-code-test-secret";

let ctx: TestDb;

beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

async function seedSession(db: TestDb["db"]) {
  const id = newId("ses");
  await db.insert(anonymousSessions).values({ id, expiresAt: new Date(Date.now() + 60_000) });
  return id;
}

async function seedIssuer(db: TestDb["db"]) {
  const id = newId("iss");
  await db.insert(issuers).values({ id, slug: id, category: "telecom", displayName: "Test Issuer" });
  return id;
}

async function seedRule(db: TestDb["db"]) {
  const id = newId("rul");
  await db.insert(rules).values({
    id, slug: id, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "x" }, confidenceBase: 0.5, author: "system", reason: "fixture",
  });
  return id;
}

/** Seeds an invoice fully hung with the children RF-147 must not lose. */
async function seedInvoiceWithFinding(
  db: TestDb["db"],
  owner: { userId?: string; sessionId?: string },
  issuerId: string,
  ruleId: string,
  contentHash: string,
) {
  const invoiceId = newId("inv");
  await db.insert(invoices).values({ id: invoiceId, ...owner, issuerId, contentHash, source: "pdf_text" });
  const itemId = newId("itm");
  await db.insert(invoiceItems).values({
    id: itemId, invoiceId, lineNo: 1, itemKey: "k1", description: "Item", normalizedDesc: "item", amountCents: 100,
  });
  const findingId = newId("fnd");
  await db.insert(findings).values({
    id: findingId, invoiceId, itemId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 100,
  });
  return { invoiceId, itemId, findingId };
}

async function requestCode(email: string, sessionId: string) {
  const result = await requestClaimCode({ email, sessionId, secret: SECRET }, ctx.db);
  if (!result.ok) throw new Error(`expected requestClaimCode to succeed, got ${JSON.stringify(result)}`);
  return result;
}

describe("requestClaimCode", () => {
  it("mints a 6-digit numeric code and never stores it in plaintext", async () => {
    const sessionId = await seedSession(ctx.db);
    const { code } = await requestCode("alice@example.com", sessionId);

    expect(code).toMatch(/^\d{6}$/);

    const [row] = await ctx.db.select().from(claimCodes).where(eq(claimCodes.sessionId, sessionId));
    expect(row?.codeHash).toBeTruthy();
    expect(row?.codeHash).not.toBe(code);
    expect(row?.codeHash).not.toContain(code);
  });

  it("normalizes the e-mail (trim + lower-case) before storing it", async () => {
    const sessionId = await seedSession(ctx.db);
    await requestCode("  Alice@Example.com  ", sessionId);

    const [row] = await ctx.db.select().from(claimCodes).where(eq(claimCodes.sessionId, sessionId));
    expect(row?.email).toBe("alice@example.com");
  });

  it("sets an expiry CLAIM_CODE_TTL_MS in the future", async () => {
    const sessionId = await seedSession(ctx.db);
    const before = Date.now();
    const { expiresAt } = await requestCode("alice@example.com", sessionId);
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(CLAIM_CODE_TTL_MS - 1000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(CLAIM_CODE_TTL_MS + 5000);
  });

  // --- §8.3: 3 per hour per e-mail ---

  it("allows exactly CLAIM_RATE_LIMIT_COUNT sends per hour, then rate-limits the next one", async () => {
    const sessionId = await seedSession(ctx.db);
    for (let i = 0; i < CLAIM_RATE_LIMIT_COUNT; i++) {
      const result = await requestClaimCode({ email: "bob@example.com", sessionId, secret: SECRET }, ctx.db);
      expect(result.ok).toBe(true);
    }
    const fourth = await requestClaimCode({ email: "bob@example.com", sessionId, secret: SECRET }, ctx.db);
    expect(fourth).toMatchObject({ ok: false, reason: "rate_limited" });
    if (!fourth.ok) expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("keys the rate limit by e-mail, not by session - a different session hitting the SAME e-mail is still limited", async () => {
    const sessionA = await seedSession(ctx.db);
    const sessionB = await seedSession(ctx.db);
    for (let i = 0; i < CLAIM_RATE_LIMIT_COUNT; i++) {
      await requestClaimCode({ email: "shared@example.com", sessionId: sessionA, secret: SECRET }, ctx.db);
    }
    // Rotating to a brand-new session buys an attacker nothing: the limit
    // tracks the e-mail address, since that is the party being protected.
    const result = await requestClaimCode({ email: "shared@example.com", sessionId: sessionB, secret: SECRET }, ctx.db);
    expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("does not let one e-mail's limit affect a different e-mail", async () => {
    const sessionId = await seedSession(ctx.db);
    for (let i = 0; i < CLAIM_RATE_LIMIT_COUNT; i++) {
      await requestClaimCode({ email: "busy@example.com", sessionId, secret: SECRET }, ctx.db);
    }
    const other = await requestClaimCode({ email: "quiet@example.com", sessionId, secret: SECRET }, ctx.db);
    expect(other.ok).toBe(true);
  });

  it("a genuine retry (asking again because the first mail never arrived) draws from the same budget, not a separate one", async () => {
    // There is no special "this is a retry" signal this function could even
    // receive - the point is that it does not need one. The 2nd and 3rd
    // calls below are indistinguishable, at the API level, from a retry;
    // they succeed because they are still within the 3-per-hour budget, the
    // exact same budget an attacker would be limited by.
    const sessionId = await seedSession(ctx.db);
    const first = await requestClaimCode({ email: "retry@example.com", sessionId, secret: SECRET }, ctx.db);
    const second = await requestClaimCode({ email: "retry@example.com", sessionId, secret: SECRET }, ctx.db);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Each request supersedes the last as the one live code - confirming
    // with the *first* code no longer works once a second was requested.
    if (first.ok) {
      const result = await confirmClaimCode(
        { email: "retry@example.com", code: first.code, sessionId, secret: SECRET }, ctx.db,
      );
      expect(result).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("does not let a wrong-code confirm attempt burn into the send budget", async () => {
    const sessionId = await seedSession(ctx.db);
    await requestCode("typo@example.com", sessionId);
    // Five wrong guesses - CLAIM_CODE_MAX_ATTEMPTS worth - exhaust the
    // *code*, not the sender's 3-per-hour budget. "wrong" is always safe to
    // assert here since a real code is a 6-digit string and "wrong-code" is
    // deliberately not one (7 characters).
    for (let i = 0; i < CLAIM_CODE_MAX_ATTEMPTS; i++) {
      await confirmClaimCode({ email: "typo@example.com", code: "wrong-code", sessionId, secret: SECRET }, ctx.db);
    }
    // All CLAIM_RATE_LIMIT_COUNT sends are still available - only 1 of them
    // was used so far.
    for (let i = 1; i < CLAIM_RATE_LIMIT_COUNT; i++) {
      const result = await requestClaimCode({ email: "typo@example.com", sessionId, secret: SECRET }, ctx.db);
      expect(result.ok).toBe(true);
    }
  });
});

describe("confirmClaimCode - the migration (RF-147, INV-008)", () => {
  it("migrates every invoice, keeping its items and findings intact", async () => {
    const sessionId = await seedSession(ctx.db);
    const issuerId = await seedIssuer(ctx.db);
    const ruleId = await seedRule(ctx.db);
    const { invoiceId, itemId, findingId } = await seedInvoiceWithFinding(
      ctx.db, { sessionId }, issuerId, ruleId, "hash-1",
    );

    const { code } = await requestCode("claim@example.com", sessionId);
    const result = await confirmClaimCode({ email: "claim@example.com", code, sessionId, secret: SECRET }, ctx.db);
    expect(result.ok).toBe(true);
    const userId = result.ok ? result.userId : never();

    const [invoice] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice?.userId).toBe(userId);
    expect(invoice?.sessionId).toBeNull();

    // Untouched: same ids, still pointing at the same (now-migrated) invoice.
    const [item] = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.id, itemId));
    const [finding] = await ctx.db.select().from(findings).where(eq(findings.id, findingId));
    expect(item?.invoiceId).toBe(invoiceId);
    expect(finding?.invoiceId).toBe(invoiceId);
    expect(finding?.id).toBe(findingId);

    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user?.email).toBe("claim@example.com");

    const [session] = await ctx.db.select().from(anonymousSessions).where(eq(anonymousSessions.id, sessionId));
    expect(session?.claimedByUserId).toBe(userId);
  });

  it("migrates the session's events too, including ones with no invoiceId", async () => {
    const sessionId = await seedSession(ctx.db);
    await ctx.db.insert(events).values({ id: newId("evt"), sessionId, type: "report_viewed", payload: {} });

    const { code } = await requestCode("events@example.com", sessionId);
    const result = await confirmClaimCode({ email: "events@example.com", code, sessionId, secret: SECRET }, ctx.db);
    const userId = result.ok ? result.userId : never();

    const rows = await ctx.db.select().from(events).where(eq(events.userId, userId));
    const reportViewed = rows.find((r) => r.type === "report_viewed");
    expect(reportViewed).toBeTruthy();
    expect(reportViewed?.sessionId).toBeNull();
  });

  it("records a session_claimed event on the new user", async () => {
    const sessionId = await seedSession(ctx.db);
    const { code } = await requestCode("audit@example.com", sessionId);
    const result = await confirmClaimCode({ email: "audit@example.com", code, sessionId, secret: SECRET }, ctx.db);
    const userId = result.ok ? result.userId : never();

    const rows = await ctx.db.select().from(events).where(eq(events.userId, userId));
    expect(rows.some((r) => r.type === "session_claimed")).toBe(true);
  });

  it("rejects a wrong code without migrating anything, and counts the attempt", async () => {
    const sessionId = await seedSession(ctx.db);
    const issuerId = await seedIssuer(ctx.db);
    const ruleId = await seedRule(ctx.db);
    await seedInvoiceWithFinding(ctx.db, { sessionId }, issuerId, ruleId, "hash-2");
    await requestCode("wrong@example.com", sessionId);

    const result = await confirmClaimCode(
      { email: "wrong@example.com", code: "000000", sessionId, secret: SECRET }, ctx.db,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });

    const [row] = await ctx.db.select().from(claimCodes).where(eq(claimCodes.sessionId, sessionId));
    expect(row?.attempts).toBe(1);
    expect(await ctx.db.select().from(users).where(eq(users.email, "wrong@example.com"))).toHaveLength(0);
  });

  it("kills the code after CLAIM_CODE_MAX_ATTEMPTS wrong guesses, even for the right code afterwards", async () => {
    const sessionId = await seedSession(ctx.db);
    const { code } = await requestCode("locked@example.com", sessionId);

    for (let i = 0; i < CLAIM_CODE_MAX_ATTEMPTS; i++) {
      const wrong = code === "111111" ? "222222" : "111111";
      const attempt = await confirmClaimCode(
        { email: "locked@example.com", code: wrong, sessionId, secret: SECRET }, ctx.db,
      );
      expect(attempt).toEqual({ ok: false, reason: "invalid" });
    }

    const result = await confirmClaimCode({ email: "locked@example.com", code, sessionId, secret: SECRET }, ctx.db);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an expired code", async () => {
    // A real PGlite connection is driven by real async I/O under the hood -
    // faking global timers around it risks hanging rather than testing
    // expiry cleanly. Backdating the stored `expires_at` directly exercises
    // exactly the same comparison (`row.expiresAt.getTime() < Date.now()`)
    // without touching the clock at all.
    const sessionId = await seedSession(ctx.db);
    const { code } = await requestCode("expired@example.com", sessionId);
    await ctx.db.update(claimCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(claimCodes.sessionId, sessionId));

    const result = await confirmClaimCode(
      { email: "expired@example.com", code, sessionId, secret: SECRET }, ctx.db,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a code confirmed under a different session than the one that requested it (INV-008)", async () => {
    const sessionA = await seedSession(ctx.db);
    const sessionB = await seedSession(ctx.db);
    const { code } = await requestCode("hijack@example.com", sessionA);

    const result = await confirmClaimCode(
      { email: "hijack@example.com", code, sessionId: sessionB, secret: SECRET }, ctx.db,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });

    const [session] = await ctx.db.select().from(anonymousSessions).where(eq(anonymousSessions.id, sessionB));
    expect(session?.claimedByUserId).toBeNull();
  });

  it("rejects confirming an e-mail/session pair that never requested a code", async () => {
    const sessionId = await seedSession(ctx.db);
    const result = await confirmClaimCode(
      { email: "never-asked@example.com", code: "123456", sessionId, secret: SECRET }, ctx.db,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  // --- safe to retry: a user who confirms twice must not end up with
  // duplicated or orphaned rows ---

  it("is idempotent: confirming the same code twice succeeds both times and does not duplicate the user or the invoice", async () => {
    const sessionId = await seedSession(ctx.db);
    const issuerId = await seedIssuer(ctx.db);
    const ruleId = await seedRule(ctx.db);
    const { invoiceId } = await seedInvoiceWithFinding(ctx.db, { sessionId }, issuerId, ruleId, "hash-3");
    const { code } = await requestCode("twice@example.com", sessionId);

    const first = await confirmClaimCode({ email: "twice@example.com", code, sessionId, secret: SECRET }, ctx.db);
    const second = await confirmClaimCode({ email: "twice@example.com", code, sessionId, secret: SECRET }, ctx.db);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.userId).toBe(first.userId);

    expect(await ctx.db.select().from(users).where(eq(users.email, "twice@example.com"))).toHaveLength(1);
    const invoiceRows = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0]?.sessionId).toBeNull();
  });

  // --- Two anonymous sessions claiming the same e-mail (phone + laptop) ---

  it("merges two different anonymous sessions claiming the same e-mail into one user, keeping both sessions' invoices", async () => {
    const sessionPhone = await seedSession(ctx.db);
    const sessionLaptop = await seedSession(ctx.db);
    const issuerId = await seedIssuer(ctx.db);
    const ruleId = await seedRule(ctx.db);
    const { invoiceId: phoneInvoice } = await seedInvoiceWithFinding(
      ctx.db, { sessionId: sessionPhone }, issuerId, ruleId, "phone-hash",
    );
    const { invoiceId: laptopInvoice } = await seedInvoiceWithFinding(
      ctx.db, { sessionId: sessionLaptop }, issuerId, ruleId, "laptop-hash",
    );

    const phoneCode = await requestCode("both@example.com", sessionPhone);
    const phoneResult = await confirmClaimCode(
      { email: "both@example.com", code: phoneCode.code, sessionId: sessionPhone, secret: SECRET }, ctx.db,
    );
    const laptopCode = await requestCode("both@example.com", sessionLaptop);
    const laptopResult = await confirmClaimCode(
      { email: "both@example.com", code: laptopCode.code, sessionId: sessionLaptop, secret: SECRET }, ctx.db,
    );

    expect(phoneResult.ok).toBe(true);
    expect(laptopResult.ok).toBe(true);
    if (phoneResult.ok && laptopResult.ok) expect(laptopResult.userId).toBe(phoneResult.userId);

    expect(await ctx.db.select().from(users).where(eq(users.email, "both@example.com"))).toHaveLength(1);
    const userId = phoneResult.ok ? phoneResult.userId : never();
    const owned = await ctx.db.select().from(invoices).where(eq(invoices.userId, userId));
    expect(owned.map((r) => r.id).sort()).toEqual([laptopInvoice, phoneInvoice].sort());
  });

  // --- The claimed e-mail already belongs to a user with their own invoices ---

  it("keeps the existing user's invoice and drops the anonymous duplicate when both share a content hash", async () => {
    const existingUserId = newId("usr");
    await ctx.db.insert(users).values({ id: existingUserId, email: "existing@example.com" });
    const issuerId = await seedIssuer(ctx.db);
    const ruleId = await seedRule(ctx.db);
    const { invoiceId: existingInvoiceId, findingId: existingFindingId } = await seedInvoiceWithFinding(
      ctx.db, { userId: existingUserId }, issuerId, ruleId, "same-hash",
    );

    const sessionId = await seedSession(ctx.db);
    const { invoiceId: dupInvoiceId } = await seedInvoiceWithFinding(
      ctx.db, { sessionId }, issuerId, ruleId, "same-hash",
    );
    // A second, non-duplicate invoice on the same session must still migrate normally.
    const { invoiceId: uniqueInvoiceId } = await seedInvoiceWithFinding(
      ctx.db, { sessionId }, issuerId, ruleId, "unique-hash",
    );

    const { code } = await requestCode("existing@example.com", sessionId);
    const result = await confirmClaimCode(
      { email: "existing@example.com", code, sessionId, secret: SECRET }, ctx.db,
    );
    expect(result).toEqual({ ok: true, userId: existingUserId });

    // The pre-existing invoice (and its finding) survive untouched.
    const [kept] = await ctx.db.select().from(invoices).where(eq(invoices.id, existingInvoiceId));
    expect(kept?.userId).toBe(existingUserId);
    const [keptFinding] = await ctx.db.select().from(findings).where(eq(findings.id, existingFindingId));
    expect(keptFinding).toBeTruthy();

    // The anonymous duplicate is gone, not left orphaned under a dead session.
    expect(await ctx.db.select().from(invoices).where(eq(invoices.id, dupInvoiceId))).toHaveLength(0);

    // The unique invoice from the same session still migrated normally.
    const [migrated] = await ctx.db.select().from(invoices).where(eq(invoices.id, uniqueInvoiceId));
    expect(migrated?.userId).toBe(existingUserId);
    expect(migrated?.sessionId).toBeNull();

    // Exactly one invoice under this user for the shared hash - no unique
    // constraint violation, no duplicate.
    const sameHash = await ctx.db.select().from(invoices)
      .where(eq(invoices.userId, existingUserId));
    expect(sameHash.filter((r) => r.contentHash === "same-hash")).toHaveLength(1);
  });
});

function never(): never {
  throw new Error("expected an ok result");
}
