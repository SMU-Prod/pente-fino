import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { caseProtocols, cases, findings, invoices, issuers, rules, users } from "../src/schema.js";
import { withUser } from "../src/with-user.js";
import { confirmedRecoveredCents } from "../src/metrics.js";

// ---------------------------------------------------------------------------
// E6 Task 3 — RF-204 verbatim: "recoveredCents só é somado quando
// outcomeConfirmedBy = diff e havia protocolo. Aceite: métrica pública nunca
// inclui auto-relato sem protocolo." This is a statement about the query,
// not about what today's one writer (Task 4's diff-close job) happens to
// produce - both filters are exercised independently below.
// ---------------------------------------------------------------------------

let ctx: TestDb;
const alice = newId("usr");

let issuerId: string;
let ruleId: string;

async function seedCase(userId: string): Promise<{ caseId: string; findingId: string; invoiceId: string }> {
  const invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, userId, issuerId, contentHash: `hash-${invoiceId}`, source: "pdf_text", status: "analyzed",
  });
  const findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1_000,
  });
  const caseId = await withUser({ userId }, ctx.db).createCase({ invoiceId, findingIds: [findingId] });
  return { caseId: caseId!, findingId, invoiceId };
}

// Bypasses closeCaseAsSystem/closeCase entirely - this file is about the
// *read* side (RF-204's query), so each case is put directly into whatever
// exact shape the test needs rather than routed through a close function
// already covered by case-protocol.test.ts.
async function setCaseClosed(
  caseId: string,
  fields: { outcomeConfirmedBy: "diff" | "user" | "none"; recoveredCents: number; closedAt?: Date },
) {
  await ctx.db.update(cases).set({
    stage: "closed",
    outcome: "resolved",
    outcomeConfirmedBy: fields.outcomeConfirmedBy,
    recoveredCents: fields.recoveredCents,
    closedAt: fields.closedAt ?? new Date("2026-03-01T12:00:00.000Z"),
  }).where(eq(cases.id, caseId));
}

async function addProtocol(caseId: string) {
  await ctx.db.insert(caseProtocols).values({
    id: newId("prt"),
    caseId,
    stage: "sac",
    protocolNumber: "P-1",
    channel: "SAC da operadora",
    registeredAt: new Date("2026-02-01T12:00:00.000Z"),
    responseDueAt: new Date("2026-02-08T12:00:00.000Z"),
  });
}

beforeEach(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values({ id: alice, email: "alice@example.com" });
  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Test Issuer" });
  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5,
    author: "system", reason: "test fixture",
  });
});
afterEach(async () => { await ctx.close(); });

describe("confirmedRecoveredCents · RF-204's public metric", () => {
  it("returns 0 for an empty database", async () => {
    expect(await confirmedRecoveredCents(ctx.db)).toBe(0);
  });

  it("excludes a user-confirmed close with a large recoveredCents, even with a protocol", async () => {
    const { caseId } = await seedCase(alice);
    await setCaseClosed(caseId, { outcomeConfirmedBy: "user", recoveredCents: 999_999 });
    await addProtocol(caseId);
    expect(await confirmedRecoveredCents(ctx.db)).toBe(0);
  });

  it("excludes a diff-confirmed close with no protocol row - RF-204's acceptance, verbatim", async () => {
    const { caseId } = await seedCase(alice);
    await setCaseClosed(caseId, { outcomeConfirmedBy: "diff", recoveredCents: 5_000 });
    expect(await confirmedRecoveredCents(ctx.db)).toBe(0);
  });

  it("includes a diff-confirmed close that has a protocol", async () => {
    const { caseId } = await seedCase(alice);
    await setCaseClosed(caseId, { outcomeConfirmedBy: "diff", recoveredCents: 5_000 });
    await addProtocol(caseId);
    expect(await confirmedRecoveredCents(ctx.db)).toBe(5_000);
  });

  it("sums two included cases exactly", async () => {
    const first = await seedCase(alice);
    await setCaseClosed(first.caseId, { outcomeConfirmedBy: "diff", recoveredCents: 5_000 });
    await addProtocol(first.caseId);

    const second = await seedCase(alice);
    await setCaseClosed(second.caseId, { outcomeConfirmedBy: "diff", recoveredCents: 3_200 });
    await addProtocol(second.caseId);

    expect(await confirmedRecoveredCents(ctx.db)).toBe(8_200);
  });

  it("mixes included and excluded cases correctly, not just when every case matches", async () => {
    const included = await seedCase(alice);
    await setCaseClosed(included.caseId, { outcomeConfirmedBy: "diff", recoveredCents: 4_000 });
    await addProtocol(included.caseId);

    const excludedNoProtocol = await seedCase(alice);
    await setCaseClosed(excludedNoProtocol.caseId, { outcomeConfirmedBy: "diff", recoveredCents: 50_000 });

    const excludedUser = await seedCase(alice);
    await setCaseClosed(excludedUser.caseId, { outcomeConfirmedBy: "user", recoveredCents: 70_000 });
    await addProtocol(excludedUser.caseId);

    expect(await confirmedRecoveredCents(ctx.db)).toBe(4_000);
  });

  it("filters by range.from/range.to on cases.closed_at", async () => {
    const inRange = await seedCase(alice);
    await setCaseClosed(inRange.caseId, {
      outcomeConfirmedBy: "diff", recoveredCents: 1_000, closedAt: new Date("2026-03-15T00:00:00.000Z"),
    });
    await addProtocol(inRange.caseId);

    const outOfRange = await seedCase(alice);
    await setCaseClosed(outOfRange.caseId, {
      outcomeConfirmedBy: "diff", recoveredCents: 9_000, closedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    await addProtocol(outOfRange.caseId);

    const total = await confirmedRecoveredCents(ctx.db, {
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T23:59:59.999Z"),
    });
    expect(total).toBe(1_000);
  });

  it("counts a case with more than one protocol row exactly once, not once per protocol", async () => {
    const { caseId } = await seedCase(alice);
    await setCaseClosed(caseId, { outcomeConfirmedBy: "diff", recoveredCents: 5_000 });
    await addProtocol(caseId);
    await ctx.db.insert(caseProtocols).values({
      id: newId("prt"),
      caseId,
      stage: "ombudsman",
      protocolNumber: "P-2",
      channel: "Ouvidoria",
      registeredAt: new Date("2026-02-10T12:00:00.000Z"),
      responseDueAt: new Date("2026-02-20T12:00:00.000Z"),
    });
    expect(await confirmedRecoveredCents(ctx.db)).toBe(5_000);
  });
});
