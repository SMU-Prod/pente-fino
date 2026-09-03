import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId, TELECOM_PLAYBOOK_V1, type EventType } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { cases, events, findings, invoices, issuers, rules, users } from "../src/schema.js";
import { withUser } from "../src/with-user.js";
import { closeCaseAsSystem } from "../src/case-close.js";
import { reopenCase } from "../src/case-reopen.js";

// ---------------------------------------------------------------------------
// E6 Task 3 — RF-203's write half: "Reabertura automática se o item voltar
// na fatura N+2, com histórico carimbado. Aceite: caso reabre no estágio
// anterior ao fechamento, com evento." Task 4's job decides *when* this
// runs (the diff between invoice N+1 and N+2); this file proves what the
// write itself does, in isolation, with a fixed clock.
// ---------------------------------------------------------------------------

let ctx: TestDb;
const alice = newId("usr");

let issuerId: string;
let ruleId: string;

const eventsOfCase = (db: TestDb["db"], caseId: string, type: EventType) =>
  db.select().from(events).where(and(eq(events.caseId, caseId), eq(events.type, type)))
    .orderBy(events.occurredAt);

const caseRow = async (db: TestDb["db"], caseId: string) =>
  (await db.select().from(cases).where(eq(cases.id, caseId)))[0];

const statusOf = async (db: TestDb["db"], findingId: string) =>
  (await db.select().from(findings).where(eq(findings.id, findingId)))[0]?.status;

async function seedCase(userId: string, findingCount = 1): Promise<{ caseId: string; findingIds: string[] }> {
  const invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, userId, issuerId, contentHash: `hash-${invoiceId}`, source: "pdf_text", status: "analyzed",
  });
  const findingIds: string[] = [];
  for (let i = 0; i < findingCount; i += 1) {
    const id = newId("fnd");
    await ctx.db.insert(findings).values({
      id, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1_000 + i,
    });
    findingIds.push(id);
  }
  const caseId = await withUser({ userId }, ctx.db).createCase({ invoiceId, findingIds });
  return { caseId: caseId!, findingIds };
}

// A case closed with `resolved`/`diff`, so its findings are `resolved` (not
// `unresolved`) and `recoveredCents` is nonzero - the exact shape RF-203
// reopens: the diff said the charge disappeared, the case closed itself,
// and now the charge is back.
async function seedClosedCase(userId: string, findingCount = 1) {
  const seeded = await seedCase(userId, findingCount);
  await closeCaseAsSystem(ctx.db, seeded.caseId, {
    outcome: "resolved", confirmedBy: "diff", recoveredCents: 5_000,
    at: new Date("2026-01-10T12:00:00.000Z"),
  });
  return seeded;
}

beforeEach(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values({ id: alice, email: "alice@example.com" });
  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({
    id: issuerId, slug: issuerId, category: "telecom", displayName: "Test Issuer",
    playbook: TELECOM_PLAYBOOK_V1,
  });
  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5,
    author: "system", reason: "test fixture",
  });
});
afterEach(async () => { await ctx.close(); });

const REOPEN_AT = new Date("2026-02-15T09:00:00.000Z");

describe("reopenCase · RF-203, the item comes back on invoice N+2", () => {
  it("moves a closed case back into the given stage, clearing the outcome and the deadline", async () => {
    const { caseId } = await seedClosedCase(alice);
    const reopened = await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    expect(reopened?.stage).toBe("sac");
    expect(reopened?.closedAt).toBeNull();
    expect(reopened?.outcome).toBeNull();
    expect(reopened?.outcomeConfirmedBy).toBeNull();
    expect(reopened?.nextDeadlineAt).toBeNull();
    expect(reopened?.stageEnteredAt).toEqual(REOPEN_AT);
    expect(reopened?.updatedAt).toEqual(REOPEN_AT);

    const row = await caseRow(ctx.db, caseId);
    expect(row?.stage).toBe("sac");
    expect(row?.closedAt).toBeNull();
  });

  // The single most important line in this task: the charge came back, so
  // the money was never recovered. A reopened case that kept its old
  // `recoveredCents` would leave §1.4's north-star metric permanently
  // counting a recovery reality reversed, indistinguishable from a real one.
  it("resets recoveredCents back to zero, because the charge coming back means the money was never recovered", async () => {
    const { caseId } = await seedClosedCase(alice);
    expect((await caseRow(ctx.db, caseId))?.recoveredCents).toBe(5_000);

    const reopened = await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    expect(reopened?.recoveredCents).toBe(0);
    expect((await caseRow(ctx.db, caseId))?.recoveredCents).toBe(0);
  });

  it("moves the case's resolved findings back to contested - the mirror of settleCaseFindings", async () => {
    const { caseId, findingIds } = await seedClosedCase(alice, 2);
    for (const id of findingIds) expect(await statusOf(ctx.db, id)).toBe("resolved");

    await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    for (const id of findingIds) expect(await statusOf(ctx.db, id)).toBe("contested");
  });

  it("leaves a finding the person has since dismissed exactly as they left it", async () => {
    const { caseId, findingIds } = await seedClosedCase(alice, 1);
    // Simulate the person dismissing the (already-resolved) finding by hand
    // between the close and the reopen.
    await ctx.db.update(findings).set({ status: "dismissed_by_user" }).where(eq(findings.id, findingIds[0]!));

    await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    expect(await statusOf(ctx.db, findingIds[0]!)).toBe("dismissed_by_user");
  });

  it("writes case_reopened with from/to/by and the optional reason/evidence", async () => {
    const { caseId } = await seedClosedCase(alice);
    await reopenCase(ctx.db, caseId, {
      stage: "sac", at: REOPEN_AT, reason: "item_reappeared", evidence: { invoiceId: "inv_xyz" },
    });
    const [reopenedEvt] = await eventsOfCase(ctx.db, caseId, "case_reopened");
    expect(reopenedEvt?.occurredAt).toEqual(REOPEN_AT);
    expect(reopenedEvt?.payload).toMatchObject({
      from: "closed", to: "sac", by: "system",
      reason: "item_reappeared", evidence: { invoiceId: "inv_xyz" },
    });
  });

  it("omits reason and evidence from the payload when neither is given", async () => {
    const { caseId } = await seedClosedCase(alice);
    await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    const [reopenedEvt] = await eventsOfCase(ctx.db, caseId, "case_reopened");
    expect(reopenedEvt?.payload).not.toHaveProperty("reason");
    expect(reopenedEvt?.payload).not.toHaveProperty("evidence");
  });

  it("also writes stage_advanced in the same shape closeCaseAsSystem writes, so both trails agree", async () => {
    const { caseId } = await seedClosedCase(alice);
    // Two `stage_advanced` rows exist by now: the original close (draft ->
    // closed) and this reopen (closed -> sac). The reopen's is the last one,
    // ordered by `occurredAt`.
    await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    const advancedEvents = await eventsOfCase(ctx.db, caseId, "stage_advanced");
    expect(advancedEvents).toHaveLength(2);
    const advanced = advancedEvents[advancedEvents.length - 1];
    expect(advanced?.occurredAt).toEqual(REOPEN_AT);
    expect(advanced?.payload).toEqual({ from: "closed", to: "sac", by: "system" });
  });

  it("is one-shot: a second reopen returns null and writes no second case_reopened", async () => {
    const { caseId } = await seedClosedCase(alice);
    const first = await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    expect(first).not.toBeNull();
    const second = await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT });
    expect(second).toBeNull();
    expect(await eventsOfCase(ctx.db, caseId, "case_reopened")).toHaveLength(1);
  });

  it("returns null for a case that is not closed - there is nothing to reopen", async () => {
    const { caseId } = await seedCase(alice);
    expect(await reopenCase(ctx.db, caseId, { stage: "sac", at: REOPEN_AT })).toBeNull();
  });

  it("returns null for a case id that does not exist", async () => {
    expect(await reopenCase(ctx.db, newId("cas"), { stage: "sac", at: REOPEN_AT })).toBeNull();
  });

  it("throws when asked to reopen into closed - a contradiction", async () => {
    const { caseId } = await seedClosedCase(alice);
    await expect(reopenCase(ctx.db, caseId, { stage: "closed", at: REOPEN_AT })).rejects.toThrow(/closed/);
  });

  it("defaults `at` to now when not given", async () => {
    const { caseId } = await seedClosedCase(alice);
    const before = Date.now();
    const reopened = await reopenCase(ctx.db, caseId, { stage: "sac" });
    const after = Date.now();
    expect(reopened?.stageEnteredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(reopened?.stageEnteredAt.getTime()).toBeLessThanOrEqual(after);
  });
});
