import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { anonymousSessions, cases, events, findings, invoices, issuers, rules, users } from "../src/schema.js";
import { withUser } from "../src/with-user.js";

let ctx: TestDb;
const alice = newId("usr");
const bob = newId("usr");

beforeEach(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values([
    { id: alice, email: "alice@example.com" },
    { id: bob, email: "bob@example.com" },
  ]);
});
afterEach(async () => { await ctx.close(); });

// --- fixtures for tests that need an issuer/rule/finding/case chain ---

async function seedIssuer(db: TestDb["db"]) {
  const id = newId("iss");
  await db.insert(issuers).values({ id, slug: id, category: "telecom", displayName: "Test Issuer" });
  return id;
}

async function seedRule(db: TestDb["db"]) {
  const id = newId("rul");
  await db.insert(rules).values({
    id, slug: id, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5,
    author: "system", reason: "test fixture",
  });
  return id;
}

async function seedFinding(db: TestDb["db"], invoiceId: string, ruleId: string) {
  const id = newId("fnd");
  await db.insert(findings).values({
    id, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 100,
  });
  return id;
}

describe("withUser", () => {
  it("returns only the caller's invoices", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.insertInvoice({ contentHash: "a1", source: "pdf_text" });
    const other = withUser({ userId: bob }, ctx.db);
    await other.insertInvoice({ contentHash: "b1", source: "pdf_text" });

    expect(await scoped.invoices()).toHaveLength(1);
    expect((await scoped.invoices())[0]?.contentHash).toBe("a1");
  });

  it("scopes an anonymous session the same way", async () => {
    const sessionId = newId("ses");
    // `invoices.session_id` carries a real FK to `anonymous_sessions.id`
    // (added in Task 7); the session row must exist before an invoice can
    // reference it.
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });
    const scoped = withUser({ sessionId }, ctx.db);
    await scoped.insertInvoice({ contentHash: "s1", source: "photo" });
    expect(await scoped.invoices()).toHaveLength(1);
    expect(await withUser({ userId: alice }, ctx.db).invoices()).toHaveLength(0);
  });

  it("stamps the owner on every recorded event", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.recordEvent("invoice_uploaded", { source: "pdf_text" });
    const rows = await scoped.events();
    expect(rows[0]?.userId).toBe(alice);
  });

  // --- A3: the event trail must be correlatable to one specific invoice
  // through the real `events.invoiceId` column, not only through the
  // owner-scoped `userId`/`sessionId` columns a session with more than one
  // invoice cannot tell apart by themselves.

  it("stamps invoiceId on a recorded event when it is passed", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const invoiceId = await scoped.insertInvoice({ contentHash: "evt-inv-1", source: "pdf_text" });
    await scoped.recordEvent("invoice_uploaded", { source: "pdf_text" }, invoiceId);

    const [row] = await ctx.db.select().from(events).where(eq(events.userId, alice));
    expect(row?.invoiceId).toBe(invoiceId);
  });

  it("leaves invoiceId null when it is not passed", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.recordEvent("invoice_uploaded", { source: "pdf_text" });

    const [row] = await ctx.db.select().from(events).where(eq(events.userId, alice));
    expect(row?.invoiceId).toBeNull();
  });

  // --- ownership cannot be forged by the caller ---
  //
  // `insertInvoice` and `recordEvent` spread the true owner *after* the
  // caller-supplied values, which is what makes a forged owner impossible
  // today. These tests pin that ordering directly against the raw row
  // (bypassing the read path's own ownership filter) so a future refactor
  // that reorders the spread — or that inlines `payload` into the insert —
  // fails loudly instead of silently reopening INV-008.
  it("cannot be tricked into stamping a forged owner via insertInvoice values", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const invoiceId = await scoped.insertInvoice({
      contentHash: "forged-inv",
      source: "pdf_text",
      // A caller has no legitimate way to pass `userId` here — `NewInvoice`
      // doesn't declare it — so this simulates a bug or a malicious caller
      // reaching past the type system, not a supported usage.
      userId: bob,
    } as unknown as Parameters<typeof scoped.insertInvoice>[0]);

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.userId).toBe(alice);
    expect(row?.sessionId).toBeNull();
  });

  it("cannot be tricked into stamping a forged owner via the event payload", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const foreignSessionId = newId("ses");
    await scoped.recordEvent("invoice_uploaded", { sessionId: foreignSessionId, source: "pdf_text" });

    const [row] = await ctx.db.select().from(events).where(eq(events.userId, alice));
    expect(row?.userId).toBe(alice);
    expect(row?.sessionId).toBeNull();
    // The forged value only ever lived inside the opaque payload column.
    expect(row?.payload).toMatchObject({ sessionId: foreignSessionId });
  });

  it("refuses to build a scope with neither owner", () => {
    // @ts-expect-error deliberately invalid session
    expect(() => withUser({}, ctx.db)).toThrow();
  });

  it("refuses to build a scope with an empty userId", () => {
    expect(() => withUser({ userId: "" }, ctx.db)).toThrow();
  });

  it("refuses to build a scope with an empty sessionId", () => {
    expect(() => withUser({ sessionId: "" }, ctx.db)).toThrow();
  });

  // --- ownership isolation, one test per method that could leak across users ---

  it("does not return another user's events", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.recordEvent("invoice_uploaded", { source: "pdf_text" });

    const other = withUser({ userId: bob }, ctx.db);
    await other.recordEvent("invoice_uploaded", { source: "photo" });

    const bobsEvents = await other.events();
    expect(bobsEvents).toHaveLength(1);
    expect(bobsEvents[0]?.userId).toBe(bob);
    expect(await scoped.events()).toHaveLength(1);
  });

  it("returns findings only for an invoice the caller owns", async () => {
    const issuerId = await seedIssuer(ctx.db);
    const ruleId = await seedRule(ctx.db);

    const scoped = withUser({ userId: alice }, ctx.db);
    const invoiceId = await scoped.insertInvoice({ contentHash: "f1", source: "pdf_text", issuerId });
    const findingId = await seedFinding(ctx.db, invoiceId, ruleId);

    const own = await scoped.findingsForInvoice(invoiceId);
    expect(own).toHaveLength(1);
    expect(own[0]?.id).toBe(findingId);

    // Bob does not own this invoice: he must see none of its findings.
    const other = withUser({ userId: bob }, ctx.db);
    expect(await other.findingsForInvoice(invoiceId)).toHaveLength(0);
  });

  it("returns only the caller's cases", async () => {
    const issuerId = await seedIssuer(ctx.db);
    const scoped = withUser({ userId: alice }, ctx.db);
    const invoiceId = await scoped.insertInvoice({ contentHash: "c1", source: "pdf_text", issuerId });

    const caseId = newId("cas");
    await ctx.db.insert(cases).values({ id: caseId, userId: alice, invoiceId, issuerId, findingIds: [] });

    const own = await scoped.cases();
    expect(own).toHaveLength(1);
    expect(own[0]?.id).toBe(caseId);

    const other = withUser({ userId: bob }, ctx.db);
    expect(await other.cases()).toHaveLength(0);
  });

  it("returns no cases for an anonymous session, since a case always belongs to a registered user", async () => {
    const sessionId = newId("ses");
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });
    const scoped = withUser({ sessionId }, ctx.db);
    expect(await scoped.cases()).toHaveLength(0);
  });
});
