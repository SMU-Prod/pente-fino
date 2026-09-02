import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  computeDeadline, newId, PROTOCOL_WINDOW_DAYS, TELECOM_PLAYBOOK_V1, type EventType,
} from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { caseProtocols, cases, events, findings, invoices, issuers, rules, users } from "../src/schema.js";
import { withUser } from "../src/with-user.js";
import { closeCaseAsSystem, SETTLED_FINDING_STATUS, settleCaseFindings } from "../src/case-close.js";

// ---------------------------------------------------------------------------
// E5 Task 5 — RF-184 (a protocol releases the wait and schedules the next
// deadline), §8.2's `advance`, and the shared settlement RF-186's day-60
// sweep needs.
// ---------------------------------------------------------------------------

let ctx: TestDb;
const alice = newId("usr");
const bob = newId("usr");

let issuerId: string;
let ruleId: string;

const eventsOfCase = (db: TestDb["db"], caseId: string, type: EventType) =>
  db.select().from(events).where(and(eq(events.caseId, caseId), eq(events.type, type)));

const protocolsOfCase = (db: TestDb["db"], caseId: string) =>
  db.select().from(caseProtocols).where(eq(caseProtocols.caseId, caseId));

const caseRow = async (db: TestDb["db"], caseId: string) =>
  (await db.select().from(cases).where(eq(cases.id, caseId)))[0];

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

beforeEach(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values([
    { id: alice, email: "alice@example.com" },
    { id: bob, email: "bob@example.com" },
  ]);
  issuerId = newId("iss");
  // Seeded with §20.2's playbook explicitly rather than relying on
  // `seedPlaybooks`: this issuer is created by the test, after the seed ran.
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

describe("recordProtocol · RF-184, the protocol releases the wait", () => {
  it("moves a draft case to sac, because a protocol number is the person having written to the channel", async () => {
    const { caseId } = await seedCase(alice);
    const registeredAt = new Date(Date.now() - 60_000);
    const result = await withUser({ userId: alice }, ctx.db).recordProtocol(caseId, {
      stage: "sac", protocolNumber: "2026080512345", channel: "SAC da operadora", registeredAt,
    });
    expect(result?.stage).toBe("sac");
    expect((await caseRow(ctx.db, caseId))?.stage).toBe("sac");
  });

  // The whole of RF-184's "libera o token de espera": the wait a case is
  // under before the protocol is RF-186's 30-day window; after it, it is the
  // playbook's 7 days from `registeredAt`. Both instants are asserted
  // against the calculator, so a wrong `event.at` (using `now` instead of
  // `registeredAt`, say) is caught rather than rounded away.
  it("replaces RF-186's protocol window with the playbook's own response deadline", async () => {
    const { caseId } = await seedCase(alice);
    const beforeWindow = (await caseRow(ctx.db, caseId))?.nextDeadlineAt;
    expect(beforeWindow).not.toBeNull();

    const registeredAt = new Date("2026-08-05T15:00:00.000Z");
    const result = await withUser({ userId: alice }, ctx.db).recordProtocol(caseId, {
      stage: "sac", protocolNumber: "2026080512345", channel: "SAC da operadora", registeredAt,
    });

    const expected = computeDeadline({ startedAt: registeredAt, days: 7, businessDays: false }).expiresAt;
    expect(result?.nextDeadlineAt).toEqual(expected);
    expect((await caseRow(ctx.db, caseId))?.nextDeadlineAt).toEqual(expected);
    expect(result?.nextDeadlineAt).not.toEqual(beforeWindow);
  });

  // RF-184's acceptance is "o workflow retoma em menos de 30 s". What that
  // has to mean here is that the new wait is visible the instant the call
  // resolves — not after a sweep, a queue drain or any other scheduled step,
  // of which none run in this test.
  it("has the new deadline committed before it returns, with nothing scheduled in between", async () => {
    const { caseId } = await seedCase(alice);
    const startedAt = Date.now();
    const result = await withUser({ userId: alice }, ctx.db).recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(),
    });
    const elapsedMs = Date.now() - startedAt;

    // Read through a *fresh* scope, so this is the database's committed
    // state and not the return value restated.
    const row = await caseRow(ctx.db, caseId);
    expect(row?.stage).toBe("sac");
    expect(row?.nextDeadlineAt).toEqual(result?.nextDeadlineAt);
    expect(elapsedMs).toBeLessThan(30_000);
  });

  it("writes the case_protocols row with responseDueAt equal to the case's own deadline", async () => {
    const { caseId } = await seedCase(alice);
    const registeredAt = new Date("2026-08-05T15:00:00.000Z");
    await withUser({ userId: alice }, ctx.db).recordProtocol(caseId, {
      stage: "sac", protocolNumber: "2026080512345", channel: "SAC da operadora", registeredAt,
    });
    const [protocol] = await protocolsOfCase(ctx.db, caseId);
    const row = await caseRow(ctx.db, caseId);
    expect(protocol).toMatchObject({
      stage: "sac", protocolNumber: "2026080512345", channel: "SAC da operadora",
      responseReceivedAt: null, responseSummary: null,
    });
    expect(protocol?.registeredAt).toEqual(registeredAt);
    // The one assertion that stops the row and the column drifting apart:
    // RF-182 prints the row's copy on a document while the sweeper acts on
    // the column's.
    expect(protocol?.responseDueAt).toEqual(row?.nextDeadlineAt);
  });

  it("writes protocol_entered and stage_advanced, and stamps stage_entered_at on the move", async () => {
    const { caseId } = await seedCase(alice);
    const before = await caseRow(ctx.db, caseId);
    await withUser({ userId: alice }, ctx.db).recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(),
    });
    const entered = await eventsOfCase(ctx.db, caseId, "protocol_entered");
    const advanced = await eventsOfCase(ctx.db, caseId, "stage_advanced");
    expect(entered).toHaveLength(1);
    expect(entered[0]?.payload).toMatchObject({ stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora" });
    expect(advanced).toHaveLength(1);
    // E6 reads `from` to know which stage to put a reopened case back into.
    expect(advanced[0]?.payload).toMatchObject({ from: "draft", to: "sac", by: "user", reason: "protocol_entered" });
    expect((await caseRow(ctx.db, caseId))!.stageEnteredAt.getTime())
      .toBeGreaterThan(before!.stageEnteredAt.getTime() - 1);
  });

  it("records no stage_advanced for a second protocol at the same stage, because the stage did not move", async () => {
    const { caseId } = await seedCase(alice);
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date("2026-08-05T15:00:00.000Z"),
    });
    const second = await scoped.recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-2", channel: "SAC da operadora", registeredAt: new Date("2026-08-10T15:00:00.000Z"),
    });
    expect(second?.stage).toBe("sac");
    expect(await eventsOfCase(ctx.db, caseId, "stage_advanced")).toHaveLength(1);
    expect(await protocolsOfCase(ctx.db, caseId)).toHaveLength(2);
    // The company's clock runs from the last time they were contacted.
    expect(second?.nextDeadlineAt).toEqual(
      computeDeadline({ startedAt: new Date("2026-08-10T15:00:00.000Z"), days: 7, businessDays: false }).expiresAt,
    );
  });

  it("rejects a stage that is not the one the protocol would attach to", async () => {
    const { caseId } = await seedCase(alice);
    const result = await withUser({ userId: alice }, ctx.db).recordProtocol(caseId, {
      stage: "consumidor_gov", protocolNumber: "P-1", channel: "consumidor.gov.br", registeredAt: new Date(),
    });
    expect(result).toBeNull();
    expect(await protocolsOfCase(ctx.db, caseId)).toEqual([]);
    expect((await caseRow(ctx.db, caseId))?.stage).toBe("draft");
  });

  // A future date is the one input error that makes a case *later* to
  // escalate: the company's deadline would be counted from a day that has
  // not happened.
  it("rejects a registeredAt in the future, writing nothing", async () => {
    const { caseId } = await seedCase(alice);
    const result = await withUser({ userId: alice }, ctx.db).recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora",
      registeredAt: new Date(Date.now() + 86_400_000),
    });
    expect(result).toBeNull();
    expect(await protocolsOfCase(ctx.db, caseId)).toEqual([]);
    expect(await eventsOfCase(ctx.db, caseId, "protocol_entered")).toEqual([]);
  });

  it("INV-008: another user's case is indistinguishable from one that never existed", async () => {
    const { caseId } = await seedCase(bob);
    const scoped = withUser({ userId: alice }, ctx.db);
    const foreign = await scoped.recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(),
    });
    const missing = await scoped.recordProtocol(newId("cas"), {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(),
    });
    expect(foreign).toEqual(missing);
    expect(foreign).toBeNull();
    // And Bob's case is untouched.
    expect(await protocolsOfCase(ctx.db, caseId)).toEqual([]);
    expect((await caseRow(ctx.db, caseId))?.stage).toBe("draft");
  });

  it("an anonymous session can own no case, so it records no protocol", async () => {
    const { caseId } = await seedCase(alice);
    const scoped = withUser({ sessionId: newId("ses") }, ctx.db);
    expect(await scoped.recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(),
    })).toBeNull();
  });

  it("refuses a closed case", async () => {
    const { caseId } = await seedCase(alice);
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.closeCase(caseId, { outcome: "denied" });
    expect(await scoped.recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(),
    })).toBeNull();
  });
});

describe("advanceCase · response_received", () => {
  async function caseWithProtocol(userId: string) {
    const { caseId, findingIds } = await seedCase(userId);
    await withUser({ userId }, ctx.db).recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(Date.now() - 60_000),
    });
    return { caseId, findingIds };
  }

  it("fills the open protocol's responseReceivedAt and summary", async () => {
    const { caseId } = await caseWithProtocol(alice);
    await withUser({ userId: alice }, ctx.db).advanceCase(caseId, {
      reason: "response_received", responseSummary: "A operadora negou o estorno.",
    });
    const [protocol] = await protocolsOfCase(ctx.db, caseId);
    expect(protocol?.responseReceivedAt).toBeInstanceOf(Date);
    expect(protocol?.responseSummary).toBe("A operadora negou o estorno.");
  });

  // The wait existed to detect silence; the channel spoke, so there is
  // nothing left for a clock to measure and escalating on it afterwards
  // would escalate on a false premise.
  it("clears the deadline and leaves the stage where it is", async () => {
    const { caseId } = await caseWithProtocol(alice);
    const result = await withUser({ userId: alice }, ctx.db).advanceCase(caseId, { reason: "response_received" });
    expect(result).toEqual({ stage: "sac", nextDeadlineAt: null });
    const row = await caseRow(ctx.db, caseId);
    expect(row?.stage).toBe("sac");
    expect(row?.nextDeadlineAt).toBeNull();
  });

  it("records response_received and no stage_advanced", async () => {
    const { caseId } = await caseWithProtocol(alice);
    await withUser({ userId: alice }, ctx.db).advanceCase(caseId, {
      reason: "response_received", responseSummary: "Resposta parcial.",
    });
    const received = await eventsOfCase(ctx.db, caseId, "response_received");
    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toMatchObject({ stage: "sac", summary: "Resposta parcial." });
    // One from the protocol's draft -> sac move, and nothing new.
    expect(await eventsOfCase(ctx.db, caseId, "stage_advanced")).toHaveLength(1);
  });

  // INV-007. `responseSummary` is free text about a person's own bill, which
  // is exactly where a CPF turns up, and both the column and the event
  // payload are durable.
  it("masks PII out of the summary before it is persisted, in both places", async () => {
    const { caseId } = await caseWithProtocol(alice);
    await withUser({ userId: alice }, ctx.db).advanceCase(caseId, {
      reason: "response_received", responseSummary: "Pediram meu CPF 529.982.247-25 no atendimento.",
    });
    const [protocol] = await protocolsOfCase(ctx.db, caseId);
    const [received] = await eventsOfCase(ctx.db, caseId, "response_received");
    expect(protocol?.responseSummary).not.toContain("529.982.247-25");
    expect(JSON.stringify(received?.payload)).not.toContain("529.982.247-25");
  });

  // A channel cannot have answered a message that was never sent. Reporting
  // success while filling nothing would leave a case claiming an answer no
  // protocol records.
  it("refuses when the stage has no open protocol", async () => {
    const { caseId } = await seedCase(alice);
    expect(await withUser({ userId: alice }, ctx.db).advanceCase(caseId, { reason: "response_received" })).toBeNull();
  });

  it("refuses a second response on a protocol that already has one", async () => {
    const { caseId } = await caseWithProtocol(alice);
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.advanceCase(caseId, { reason: "response_received" });
    expect(await scoped.advanceCase(caseId, { reason: "response_received" })).toBeNull();
  });
});

describe("advanceCase · user_request", () => {
  it("escalates a protocolled sac case to consumidor.gov.br with RF-186's window", async () => {
    const { caseId } = await seedCase(alice);
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(Date.now() - 60_000),
    });
    const before = Date.now();
    const result = await scoped.advanceCase(caseId, { reason: "user_request" });
    expect(result?.stage).toBe("consumidor_gov");
    // The new channel has no protocol yet, so what runs there is RF-186's
    // 30-day window, not consumidor.gov.br's 10-day response time.
    const days = (result!.nextDeadlineAt!.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(33.1);
  });

  // The point of the whole `user_request` design: RF-182 reads
  // `deadline_expired` rows to decide a document may state that a company
  // let a deadline pass. A person escalating early has not earned that
  // claim, and a forged row here would put it on a letter the company can
  // disprove in one line.
  it("never writes a deadline_expired event for an escalation nobody's clock caused", async () => {
    const { caseId } = await seedCase(alice);
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.recordProtocol(caseId, {
      stage: "sac", protocolNumber: "P-1", channel: "SAC da operadora", registeredAt: new Date(Date.now() - 60_000),
    });
    await scoped.advanceCase(caseId, { reason: "user_request" });
    expect(await eventsOfCase(ctx.db, caseId, "deadline_expired")).toEqual([]);
    const advanced = await eventsOfCase(ctx.db, caseId, "stage_advanced");
    expect(advanced).toHaveLength(2);
    expect(advanced[1]?.payload).toMatchObject({ from: "sac", to: "consumidor_gov", reason: "user_request" });
  });

  // §9.1's `stalled` sub-state: no protocol means the person never wrote to
  // the channel, so there is no company silence to escalate against, and
  // every channel past `sac` needs the previous protocol to file at all.
  it("sends a case with no protocol back to sac with the window restarted, not onwards", async () => {
    const { caseId } = await seedCase(alice);
    const result = await withUser({ userId: alice }, ctx.db).advanceCase(caseId, { reason: "user_request" });
    expect(result?.stage).toBe("sac");
    expect(result?.nextDeadlineAt).not.toBeNull();
  });

  it("INV-008: another user's case is indistinguishable from one that never existed", async () => {
    const { caseId } = await seedCase(bob);
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.advanceCase(caseId, { reason: "user_request" }))
      .toEqual(await scoped.advanceCase(newId("cas"), { reason: "user_request" }));
    expect((await caseRow(ctx.db, caseId))?.stage).toBe("draft");
  });

  it("refuses a closed case", async () => {
    const { caseId } = await seedCase(alice);
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.closeCase(caseId, { outcome: "denied" });
    expect(await scoped.advanceCase(caseId, { reason: "user_request" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The dead end E5 Task 4 handed on: `closeCase` was the only code that moved
// a finding out of `contested`, and it is a `withUser` method a system job
// cannot reach. A case closed by RF-186's day-60 sweep would leave its
// findings shown on the report as a live dispute forever
// (`VISIBLE_FINDING_STATUSES` includes `contested`) and permanently barred
// from a new case (`CONTESTABLE_FINDING_STATUSES` excludes it).
// ---------------------------------------------------------------------------
describe("closeCaseAsSystem · RF-186's day-60 close, reachable without a session", () => {
  const statusOf = async (findingId: string) =>
    (await ctx.db.select().from(findings).where(eq(findings.id, findingId)))[0]?.status;

  it("closes the case as abandoned and settles every finding it was disputing", async () => {
    const { caseId, findingIds } = await seedCase(alice, 2);
    expect(await statusOf(findingIds[0]!)).toBe("contested");

    const closed = await closeCaseAsSystem(ctx.db, caseId, { outcome: "abandoned" });
    expect(closed?.outcome).toBe("abandoned");

    const row = await caseRow(ctx.db, caseId);
    expect(row?.stage).toBe("closed");
    expect(row?.closedAt).toBeInstanceOf(Date);
    expect(row?.nextDeadlineAt).toBeNull();
    // The half that was missing. `unresolved` is the money staying exactly
    // as live as it was, which is what lets it into a new case.
    for (const id of findingIds) expect(await statusOf(id)).toBe("unresolved");
  });

  it("a settled finding can enter a new case, which is the whole point", async () => {
    const { caseId, findingIds } = await seedCase(alice);
    await closeCaseAsSystem(ctx.db, caseId, { outcome: "abandoned" });
    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));
    const again = await withUser({ userId: alice }, ctx.db)
      .createCase({ invoiceId: row!.invoiceId, findingIds });
    expect(again).toEqual(expect.any(String));
  });

  it("writes outcome_confirmed and stage_advanced, in the shapes closeCase writes", async () => {
    const { caseId } = await seedCase(alice);
    await closeCaseAsSystem(ctx.db, caseId, { outcome: "abandoned" });
    const confirmed = await eventsOfCase(ctx.db, caseId, "outcome_confirmed");
    const advanced = await eventsOfCase(ctx.db, caseId, "stage_advanced");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.payload).toMatchObject({ outcome: "abandoned", confirmedBy: "none" });
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.payload).toMatchObject({ from: "draft", to: "closed", by: "system", outcome: "abandoned" });
  });

  it("stamps outcome_confirmed_by as none, not as the user who never confirmed it", async () => {
    const { caseId } = await seedCase(alice);
    await closeCaseAsSystem(ctx.db, caseId, { outcome: "abandoned" });
    expect((await caseRow(ctx.db, caseId))?.outcomeConfirmedBy).toBe("none");
  });

  it("closes once: a repeated sweep over the same case returns null and writes nothing more", async () => {
    const { caseId } = await seedCase(alice);
    await closeCaseAsSystem(ctx.db, caseId, { outcome: "abandoned" });
    expect(await closeCaseAsSystem(ctx.db, caseId, { outcome: "abandoned" })).toBeNull();
    expect(await eventsOfCase(ctx.db, caseId, "outcome_confirmed")).toHaveLength(1);
  });

  it("masks PII out of the note before it reaches the durable event payload (INV-007)", async () => {
    const { caseId } = await seedCase(alice);
    await closeCaseAsSystem(ctx.db, caseId, { outcome: "abandoned", note: "Sem retorno do CPF 529.982.247-25." });
    const [confirmed] = await eventsOfCase(ctx.db, caseId, "outcome_confirmed");
    expect(JSON.stringify(confirmed?.payload)).not.toContain("529.982.247-25");
  });
});

describe("settleCaseFindings · the mapping both closes share", () => {
  it("maps every outcome the way a report can honestly show it", () => {
    expect(SETTLED_FINDING_STATUS).toEqual({
      resolved: "resolved",
      // Not `resolved`: a case records how much came back, never *which*
      // findings a partial recovery covered, so calling them resolved would
      // hide money from the report that was never recovered.
      partial: "unresolved",
      denied: "unresolved",
      abandoned: "unresolved",
    });
  });

  it("is what closeCase uses, so a user close and a system close agree", async () => {
    const first = await seedCase(alice);
    const second = await seedCase(alice);
    await withUser({ userId: alice }, ctx.db).closeCase(first.caseId, { outcome: "partial", recoveredCents: 500 });
    await closeCaseAsSystem(ctx.db, second.caseId, { outcome: "partial" });
    const statusOf = async (id: string) =>
      (await ctx.db.select().from(findings).where(eq(findings.id, id)))[0]?.status;
    expect(await statusOf(first.findingIds[0]!)).toBe(await statusOf(second.findingIds[0]!));
    expect(await statusOf(first.findingIds[0]!)).toBe("unresolved");
  });

  it("touches only findings this case is actually contesting", async () => {
    const { findingIds } = await seedCase(alice);
    const untouched = newId("fnd");
    const [row] = await ctx.db.select().from(cases).where(eq(cases.userId, alice));
    await ctx.db.insert(findings).values({
      id: untouched, invoiceId: row!.invoiceId, ruleId, ruleVersion: 1, confidence: 0.9,
      amountCents: 2_000, status: "dismissed_by_user",
    });
    await ctx.db.transaction(async (tx) => {
      const settled = await settleCaseFindings(tx, {
        findingIds: [...findingIds, untouched], outcome: "resolved", at: new Date(),
      });
      // Only the contested one moved; the dismissal the person chose stands.
      expect(settled).toBe(findingIds.length);
    });
    const [after] = await ctx.db.select().from(findings).where(eq(findings.id, untouched));
    expect(after?.status).toBe("dismissed_by_user");
  });
});

describe("RF-186 · the window that had no owner", () => {
  it("is stamped at creation, so the deadline scan can see a case with no protocol", async () => {
    const before = new Date();
    const { caseId } = await seedCase(alice);
    const row = await caseRow(ctx.db, caseId);
    expect(row?.nextDeadlineAt).toEqual(
      computeDeadline({ startedAt: before, days: PROTOCOL_WINDOW_DAYS, businessDays: false }).expiresAt,
    );
  });
});
