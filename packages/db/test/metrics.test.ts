import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { caseProtocols, cases, findings, invoices, issuers, rules, users } from "../src/schema.js";
import { withUser } from "../src/with-user.js";
import { closeCaseAsSystem } from "../src/case-close.js";
import { reopenCase } from "../src/case-reopen.js";
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

  // `outcomeConfirmedBy` has three values - `diff`, `user`, `none` - and only
  // `user` was ever exercised as an excluded value above. Writing
  // `ne(cases.outcomeConfirmedBy, "user")` instead of `eq(..., "diff")`
  // would pass every other test in this file while letting RF-186's
  // abandonment shape (`none`, no confirmation at all) leak into the
  // metric.
  it("excludes a none-confirmed close - RF-186's abandonment shape - even with a protocol and a positive recoveredCents", async () => {
    const { caseId } = await seedCase(alice);
    await setCaseClosed(caseId, { outcomeConfirmedBy: "none", recoveredCents: 12_345 });
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

// ---------------------------------------------------------------------------
// Every test above bypasses closeCaseAsSystem and reopenCase on purpose
// (`setCaseClosed`'s own comment): this file is about the *query*, proven
// correct independent of who writes the rows. That is exactly what RF-204's
// acceptance demands, and none of those tests are touched here.
//
// But RF-203 and RF-204 also make a joint promise - a diff-confirmed close
// counts towards the metric, and a reopen (the charge coming back) makes it
// stop counting - and nothing exercises that promise through the real
// writers. This is the one test that does: `closeCaseAsSystem` and
// `reopenCase` from `case-close.ts`/`case-reopen.ts`, read back through
// `confirmedRecoveredCents`.
// ---------------------------------------------------------------------------
describe("confirmedRecoveredCents · the end-to-end promise RF-203 and RF-204 jointly make", () => {
  it("counts a diff-confirmed close's recoveredCents, then stops counting it once the case reopens", async () => {
    const { caseId } = await seedCase(alice);
    await addProtocol(caseId);

    await closeCaseAsSystem(ctx.db, caseId, {
      outcome: "resolved", confirmedBy: "diff", recoveredCents: 5_000,
    });
    expect(await confirmedRecoveredCents(ctx.db)).toBe(5_000);

    await reopenCase(ctx.db, caseId, { stage: "sac" });
    expect(await confirmedRecoveredCents(ctx.db)).toBe(0);

    // The metric assertion just above cannot, on its own, tell a properly
    // reset `recoveredCents` apart from a stale one: `reopenCase` also
    // clears `outcomeConfirmedBy` in the same write, and that alone already
    // excludes the row from the sum regardless of what `recoveredCents`
    // holds. Reading the column directly is what actually exercises
    // `case-reopen.ts`'s own reset line - see this test's own mutation
    // record in the task report for why the metric-only version of this
    // assertion does not.
    const [row] = await ctx.db.select({ recoveredCents: cases.recoveredCents })
      .from(cases).where(eq(cases.id, caseId));
    expect(row?.recoveredCents).toBe(0);
  });
});
