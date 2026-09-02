import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { newId, type ContestDocument } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  anonymousSessions, caseDocuments, caseProtocols, cases, events, findings, invoices, issuers, rules, users,
} from "../src/schema.js";
import { withUser } from "../src/with-user.js";

let ctx: TestDb;
const alice = newId("usr");
const bob = newId("usr");

let issuerId: string;
let ruleId: string;
let aliceInvoice: string;
let bobInvoice: string;
let aliceFinding: string;
let bobFinding: string;

// Same shape `case-documents.test.ts` uses: long enough for `body`'s
// 200-character floor, short enough to stay readable in a diff.
const SAMPLE_BODY: ContestDocument = {
  subject: "Cobrança em duplicidade na fatura",
  body:
    "Solicito a revisão da cobrança referente ao item que aparece em duplicidade na fatura deste período. " +
    "Peço a confirmação do valor correto e o registro do protocolo deste atendimento para acompanhamento.",
  requests: ["Revisar o valor cobrado"],
  legalRefs: [{ law: "CDC", article: "Art. 42" }],
  scriptForCall: ["Pedir o número de protocolo do atendimento"],
  attachmentsChecklist: ["Fatura do período contestado"],
};

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

async function seedInvoice(db: TestDb["db"], userId: string, withIssuer = true) {
  const id = newId("inv");
  await db.insert(invoices).values({
    id, userId, ...(withIssuer ? { issuerId } : {}),
    contentHash: `hash-${id}`, source: "pdf_text", status: "analyzed",
  });
  return id;
}

// An invoice owned by a bare session rather than a user - which is exactly
// how `invoices.session_id` stores an unclaimed visitor's upload, and the
// only shape in which `ownsInvoice` matches for an anonymous caller.
async function seedSessionInvoice(db: TestDb["db"], sessionId: string) {
  const id = newId("inv");
  await db.insert(invoices).values({
    id, sessionId, issuerId,
    contentHash: `hash-${id}`, source: "pdf_text", status: "analyzed",
  });
  return id;
}

async function seedFinding(
  db: TestDb["db"],
  invoiceId: string,
  extra: { id?: string; status?: string; shadow?: boolean; amountCents?: number } = {},
) {
  const id = extra.id ?? newId("fnd");
  await db.insert(findings).values({
    id, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9,
    amountCents: extra.amountCents ?? 1_000,
    ...(extra.status ? { status: extra.status } : {}),
    ...(extra.shadow === undefined ? {} : { shadow: extra.shadow }),
  });
  return id;
}

async function anonymousScope(db: TestDb["db"]) {
  const sessionId = newId("ses");
  await db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });
  return { sessionId, scoped: withUser({ sessionId }, db) };
}

// Every `cases` assertion is scoped to the user under test rather than
// reading the whole table: `createTestDb` runs `seedAll`, and a seed that
// one day ships a case would otherwise turn a dozen unrelated tests red.
const casesOf = (db: TestDb["db"], userId: string) =>
  db.select().from(cases).where(eq(cases.userId, userId));

beforeEach(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values([
    { id: alice, email: "alice@example.com" },
    { id: bob, email: "bob@example.com" },
  ]);
  issuerId = await seedIssuer(ctx.db);
  ruleId = await seedRule(ctx.db);
  aliceInvoice = await seedInvoice(ctx.db, alice);
  bobInvoice = await seedInvoice(ctx.db, bob);
  aliceFinding = await seedFinding(ctx.db, aliceInvoice);
  bobFinding = await seedFinding(ctx.db, bobInvoice);
});
afterEach(async () => { await ctx.close(); });

describe("createCase (the case-creation hole E5 Task 4 fills, INV-008)", () => {
  it("opens the case at draft with no deadline, stamped with the invoice's issuer", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] });
    expect(caseId).toEqual(expect.any(String));

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId!));
    expect(row).toMatchObject({
      userId: alice,
      invoiceId: aliceInvoice,
      issuerId,
      stage: "draft",
      nextDeadlineAt: null,
      findingIds: [aliceFinding],
      outcome: null,
      closedAt: null,
    });
  });

  it("flips every finding the case names to contested", async () => {
    const second = await seedFinding(ctx.db, aliceInvoice, { status: "confirmed_by_user" });
    const scoped = withUser({ userId: alice }, ctx.db);
    await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding, second] });

    const rows = await ctx.db.select().from(findings).where(inArray(findings.id, [aliceFinding, second]));
    expect(rows.map((r) => r.status).sort()).toEqual(["contested", "contested"]);
  });

  // The two ids are chosen so that first-seen order and sorted order differ:
  // `zz` is picked first but sorts last. With random nanoids a `.sort()`
  // slipped into the dedupe passes roughly half the time.
  it("dedupes findingIds, preserving first-seen order", async () => {
    const pickedFirst = await seedFinding(ctx.db, aliceInvoice, { id: "fnd_zz_picked_first" });
    const pickedSecond = await seedFinding(ctx.db, aliceInvoice, { id: "fnd_aa_picked_second" });
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = await scoped.createCase({
      invoiceId: aliceInvoice, findingIds: [pickedFirst, pickedSecond, pickedFirst],
    });

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId!));
    expect(row?.findingIds).toEqual([pickedFirst, pickedSecond]);
  });

  // The `findingIds.length === 0` short-circuit in `createCase` is legibility,
  // not behaviour: drizzle compiles `inArray(col, [])` to `false`, so an empty
  // array would be rejected by the row-count test and then by the `issuerId`
  // test anyway. This asserts the outcome, and is not evidence the guard line
  // does anything.
  it("refuses an empty findingIds array - a case that contests nothing is not a case", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [] })).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
  });

  // A3: every state transition writes an `events` row, and a case coming into
  // existence is the first transition there is. It is written inside
  // `createCase`'s own transaction, not by the route, so a crash cannot leave
  // a committed case whose creation the trail never recorded.
  it("writes exactly one case_created event, stamped with both the invoice and the case", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;

    const rows = await ctx.db.select().from(events).where(eq(events.type, "case_created"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alice, invoiceId: aliceInvoice, caseId });
    expect(rows[0]?.payload).toMatchObject({
      invoiceId: aliceInvoice, findingIds: [aliceFinding], stage: "draft",
    });
  });

  it("leaves no case_created event behind when the create is rejected", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.createCase({
      invoiceId: aliceInvoice, findingIds: [aliceFinding, bobFinding],
    })).toBeNull();
    expect(await ctx.db.select().from(events).where(eq(events.type, "case_created"))).toHaveLength(0);
  });

  // The validating SELECT runs outside the transaction, so two callers can
  // both read the same finding as contestable. The invariant is therefore in
  // the write: the flip to `contested` carries the contestability test in its
  // own WHERE and the transaction rolls back unless it touched every finding
  // the case names. Without that, both callers insert and the same money ends
  // up in two live cases - double-counted into §1.4's north-star metric the
  // moment both close.
  it("opens only one case when two calls race for the same finding", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const results = await Promise.allSettled([
      scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }),
      scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }),
    ]);

    const opened = results.filter((r) => r.status === "fulfilled" && r.value !== null);
    expect(opened).toHaveLength(1);
    expect(await casesOf(ctx.db, alice)).toHaveLength(1);
    expect(await ctx.db.select().from(events).where(eq(events.type, "case_created"))).toHaveLength(1);
    const [contested] = await ctx.db.select().from(findings).where(eq(findings.id, aliceFinding));
    expect(contested?.status).toBe("contested");
  });

  // --- INV-008: the whole point of this task. `findingIds` is caller-supplied
  // and is NOT covered by the outer `invoiceId` check.
  it("refuses a findingIds array that smuggles in another user's finding", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = await scoped.createCase({
      invoiceId: aliceInvoice, findingIds: [aliceFinding, bobFinding],
    });

    expect(caseId).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
    const [smuggled] = await ctx.db.select().from(findings).where(eq(findings.id, bobFinding));
    expect(smuggled?.status).toBe("open");
  });

  it("refuses another user's finding named with that same user's invoice", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.createCase({ invoiceId: bobInvoice, findingIds: [bobFinding] })).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
    const [untouched] = await ctx.db.select().from(findings).where(eq(findings.id, bobFinding));
    expect(untouched?.status).toBe("open");
  });

  it("refuses a finding id that does not exist at all", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = await scoped.createCase({
      invoiceId: aliceInvoice, findingIds: [aliceFinding, newId("fnd")],
    });
    expect(caseId).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
  });

  it("refuses a finding of a different invoice of the same owner", async () => {
    const otherInvoice = await seedInvoice(ctx.db, alice);
    const otherFinding = await seedFinding(ctx.db, otherInvoice);
    const scoped = withUser({ userId: alice }, ctx.db);

    const caseId = await scoped.createCase({
      invoiceId: aliceInvoice, findingIds: [aliceFinding, otherFinding],
    });
    expect(caseId).toBeNull();
    const [untouched] = await ctx.db.select().from(findings).where(eq(findings.id, otherFinding));
    expect(untouched?.status).toBe("open");
  });

  it("refuses a shadow finding - RF-125 never let it reach the user", async () => {
    const hidden = await seedFinding(ctx.db, aliceInvoice, { shadow: true });
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [hidden] })).toBeNull();
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding, hidden] })).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
  });

  it("refuses a dismissed_by_user finding - the person said the charge is theirs", async () => {
    const dismissed = await seedFinding(ctx.db, aliceInvoice, { status: "dismissed_by_user" });
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [dismissed] })).toBeNull();
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding, dismissed] })).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
  });

  it("refuses a finding already contested by another case, so a double submit cannot duplicate it", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const first = await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] });
    expect(first).toEqual(expect.any(String));

    const second = await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] });
    expect(second).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(1);
  });

  it("accepts an unresolved finding - a failed dispute leaves the money exactly as live as open", async () => {
    const retry = await seedFinding(ctx.db, aliceInvoice, { status: "unresolved" });
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [retry] })).toEqual(expect.any(String));
  });

  it("refuses an invoice with no issuer - a case has no playbook without one", async () => {
    const orphan = await seedInvoice(ctx.db, alice, false);
    const orphanFinding = await seedFinding(ctx.db, orphan);
    const scoped = withUser({ userId: alice }, ctx.db);

    expect(await scoped.createCase({ invoiceId: orphan, findingIds: [orphanFinding] })).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
    const [untouched] = await ctx.db.select().from(findings).where(eq(findings.id, orphanFinding));
    expect(untouched?.status).toBe("open");
  });

  // The session owns the invoice it names, which is the only configuration
  // where the `!userId` guard is the thing being tested: `resolveSession`
  // hands `{ sessionId }` to an unclaimed visitor, `invoices.session_id` is
  // exactly how that visitor's invoice is stored, so `ownsInvoice` matches
  // and the findings validate. Without the guard the insert reaches
  // `cases.user_id` NOT NULL and throws - a 500 where INV-008 requires the
  // same `null` every other rejection returns. A session that owned nothing
  // would pass this test for the wrong reason.
  it("returns null for an anonymous session that owns the invoice - cases.userId is NOT NULL", async () => {
    const { sessionId, scoped } = await anonymousScope(ctx.db);
    const sessionInvoice = await seedSessionInvoice(ctx.db, sessionId);
    const sessionFinding = await seedFinding(ctx.db, sessionInvoice);

    expect(await scoped.createCase({ invoiceId: sessionInvoice, findingIds: [sessionFinding] })).toBeNull();
    expect(await ctx.db.select().from(cases).where(eq(cases.invoiceId, sessionInvoice))).toHaveLength(0);
    const [untouched] = await ctx.db.select().from(findings).where(eq(findings.id, sessionFinding));
    expect(untouched?.status).toBe("open");
  });
});

describe("caseDetail (the case, its documents, its protocols and its timeline)", () => {
  // Fixtures sit after "now" so they sort after the real `case_created` row
  // `createCase` writes in its own transaction - the timeline assertions
  // below therefore read as "creation first, then what happened next".
  const T0 = new Date(Date.now() + 60_000);
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  // Every fixture below is inserted in reverse chronological order, so a
  // method that just returns insertion order fails these assertions.
  async function seedTimelineFixtures(db: TestDb["db"], caseId: string) {
    await db.insert(caseDocuments).values([
      { id: newId("doc"), caseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY, createdAt: at(20) },
      { id: newId("doc"), caseId, stage: "draft", kind: "contest_letter", promptVersion: 1, body: SAMPLE_BODY, createdAt: at(10) },
    ]);
    await db.insert(caseProtocols).values([
      {
        id: newId("prt"), caseId, stage: "consumidor_gov", protocolNumber: "P-2", channel: "web",
        registeredAt: at(40), responseDueAt: at(40 + 60 * 24 * 10),
      },
      {
        id: newId("prt"), caseId, stage: "sac", protocolNumber: "P-1", channel: "phone",
        registeredAt: at(30), responseDueAt: at(30 + 60 * 24 * 5),
      },
    ]);
  }

  it("returns documents, protocols and the timeline in chronological order", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    await seedTimelineFixtures(ctx.db, caseId);
    await ctx.db.insert(events).values([
      { id: newId("evt"), userId: alice, caseId, type: "contest_marked_sent", payload: {}, occurredAt: at(30) },
      { id: newId("evt"), userId: alice, caseId, type: "protocol_entered", payload: {}, occurredAt: at(5) },
    ]);

    const detail = await scoped.caseDetail(caseId);
    expect(detail?.case).toMatchObject({ id: caseId, userId: alice, stage: "draft", findingIds: [aliceFinding] });
    expect(detail?.documents.map((d) => d.kind)).toEqual(["contest_letter", "sac_script"]);
    expect(detail?.protocols.map((p) => p.protocolNumber)).toEqual(["P-1", "P-2"]);
    expect(detail?.timeline.map((e) => e.type)).toEqual([
      "case_created", "protocol_entered", "contest_marked_sent",
    ]);
  });

  // Decision 6: the timeline is scoped on `events.caseId` alone, never on the
  // caller's own `ownsEvent` predicate. E5 Task 3's deadline job has no user
  // session, so the rows it writes carry no `userId` - an `ownsEvent` filter
  // would silently drop exactly the events nobody else records.
  it("includes a system event written with a caseId but no userId", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    await ctx.db.insert(events).values([
      // No userId and no sessionId, exactly as the deadline job writes it.
      { id: newId("evt"), caseId, type: "deadline_expired", payload: { stage: "sac" }, occurredAt: at(2) },
      { id: newId("evt"), caseId, type: "stage_advanced", payload: { to: "consumidor_gov" }, occurredAt: at(3) },
    ]);

    const detail = await scoped.caseDetail(caseId);
    expect(detail?.timeline.map((e) => e.type)).toEqual(["case_created", "deadline_expired", "stage_advanced"]);
    expect(detail?.timeline[1]?.userId).toBeNull();
  });

  // The name used to promise more than the fixtures proved: three rows that
  // differ only by `caseId IS NULL` cannot show that an event carrying a
  // *different* case id is excluded. The second case below is the point;
  // sharing an owner with the first is deliberate, so `caseId` is the only
  // thing separating them.
  it("scopes the timeline to its own case, including against another case of the same owner", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const otherFinding = await seedFinding(ctx.db, aliceInvoice);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    const otherCaseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [otherFinding] }))!;
    await ctx.db.insert(events).values([
      { id: newId("evt"), userId: alice, caseId, type: "protocol_entered", payload: {}, occurredAt: at(1) },
      { id: newId("evt"), userId: alice, caseId: otherCaseId, type: "protocol_entered", payload: {}, occurredAt: at(2) },
      { id: newId("evt"), userId: bob, type: "case_created", payload: {}, occurredAt: at(3) },
      { id: newId("evt"), userId: alice, type: "report_viewed", payload: {}, occurredAt: at(4) },
    ]);

    const detail = await scoped.caseDetail(caseId);
    // Its own `case_created` plus its own `protocol_entered`, and nothing
    // from the sibling case, which has exactly the same two.
    expect(detail?.timeline.map((e) => e.type)).toEqual(["case_created", "protocol_entered"]);
    expect(detail?.timeline.every((e) => e.caseId === caseId)).toBe(true);
  });

  it("returns exactly the same value for another user's case and for a case that does not exist", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    await seedTimelineFixtures(ctx.db, caseId);

    const other = withUser({ userId: bob }, ctx.db);
    const notMine = await other.caseDetail(caseId);
    const notThere = await other.caseDetail(newId("cas"));
    expect(notMine).toBeNull();
    expect(notMine).toEqual(notThere);
  });

  it("returns null for an anonymous session, whatever the caseId", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    const { scoped: anon } = await anonymousScope(ctx.db);
    expect(await anon.caseDetail(caseId)).toBeNull();
  });
});

describe("closeCase (§1.4's north-star metric is fed from here, so it may only happen once)", () => {
  async function openCase(findingIds: string[]) {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds }))!;
    return { scoped, caseId };
  }

  it("records the outcome, who confirmed it, the money recovered and the closing time", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);

    const closed = await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 12_345 });
    expect(closed).toMatchObject({
      id: caseId,
      invoiceId: aliceInvoice,
      stage: "closed",
      outcome: "resolved",
      outcomeConfirmedBy: "user",
      recoveredCents: 12_345,
      nextDeadlineAt: null,
    });
    expect(closed?.closedAt).toBeInstanceOf(Date);

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));
    expect(row).toMatchObject({ stage: "closed", outcome: "resolved", recoveredCents: 12_345 });
  });

  it("defaults recoveredCents to zero rather than leaving it null", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    const closed = await scoped.closeCase(caseId, { outcome: "denied" });
    expect(closed?.recoveredCents).toBe(0);
  });

  // Without this the row would keep claiming the case entered `closed` at the
  // moment it actually entered `sac` - the one timestamp anything reading the
  // stage machine has to trust.
  it("stamps stageEnteredAt with the moment the case entered closed", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    const enteredSac = new Date("2026-04-01T09:00:00.000Z");
    await ctx.db.update(cases).set({ stage: "sac", stageEnteredAt: enteredSac }).where(eq(cases.id, caseId));

    const closed = await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 1_000 });
    expect(closed?.stageEnteredAt).toEqual(closed?.closedAt);
    expect(closed?.stageEnteredAt).not.toEqual(enteredSac);
  });

  // "Money is integer cents, always" had no enforcement at this layer: a
  // fractional value only failed at the column, and a negative one succeeded
  // and quietly subtracted from §1.4's north-star metric. It throws rather
  // than returning `null`, which means "no such case of yours" - a caller
  // must not be told a bad argument is a missing row.
  it.each([-1, -12_345, 12.5])("refuses recoveredCents %s and leaves the case open", async (bad) => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await expect(scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: bad }))
      .rejects.toThrow(/non-negative integer/);

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));
    expect(row).toMatchObject({ stage: "draft", outcome: null, closedAt: null });
    expect(await ctx.db.select().from(events).where(eq(events.type, "outcome_confirmed"))).toHaveLength(0);
  });

  // A3, and unrepairable if left to the route: the close is one-shot, so a
  // crash between a committed close and a route-written event would leave a
  // closed case whose `outcome_confirmed` can never be written - the retry
  // hits `isNull(closedAt)` and returns `null`.
  it("writes exactly one outcome_confirmed event, carrying the outcome and the money recovered", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await scoped.closeCase(caseId, { outcome: "partial", recoveredCents: 4_200 });

    const rows = await ctx.db.select().from(events).where(eq(events.type, "outcome_confirmed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alice, invoiceId: aliceInvoice, caseId });
    expect(rows[0]?.payload).toMatchObject({
      outcome: "partial", recoveredCents: 4_200, confirmedBy: "user",
    });
  });

  it("writes no second outcome_confirmed event when the close is repeated", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 9_900 });
    expect(await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 9_900 })).toBeNull();

    expect(await ctx.db.select().from(events).where(eq(events.type, "outcome_confirmed"))).toHaveLength(1);
  });

  // INV-007: PII is masked before it is persisted, and free text a person
  // types about their own bill is exactly where a CPF turns up. The masking
  // happens inside `closeCase`, not in the route - a step a caller can forget
  // is a step that will eventually be forgotten, and the event row is durable.
  it("masks a CPF in the note before the event payload is persisted", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await scoped.closeCase(caseId, {
      outcome: "resolved",
      recoveredCents: 1_000,
      note: "Atendente confirmou o estorno, CPF 123.456.789-09 conferido no protocolo",
    });

    const [row] = await ctx.db.select().from(events).where(eq(events.type, "outcome_confirmed"));
    expect(row?.payload.note).toBe("Atendente confirmou o estorno, CPF [CPF] conferido no protocolo");
    expect(JSON.stringify(row?.payload)).not.toContain("123.456.789-09");
  });

  it("carries no note key at all when the person did not write one", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await scoped.closeCase(caseId, { outcome: "denied" });

    const [row] = await ctx.db.select().from(events).where(eq(events.type, "outcome_confirmed"));
    expect(row?.payload).not.toHaveProperty("note");
  });

  it("can only be closed once - a second close returns null and changes nothing", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 9_900 });
    const [first] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));

    const second = await scoped.closeCase(caseId, { outcome: "partial", recoveredCents: 100 });
    expect(second).toBeNull();

    const [after] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));
    expect(after?.outcome).toBe("resolved");
    expect(after?.recoveredCents).toBe(9_900);
    expect(after?.closedAt).toEqual(first?.closedAt);
  });

  it("returns null for another user's case, the same value a second close gets", async () => {
    const { caseId } = await openCase([aliceFinding]);
    const other = withUser({ userId: bob }, ctx.db);

    expect(await other.closeCase(caseId, { outcome: "resolved", recoveredCents: 500 })).toBeNull();
    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));
    expect(row).toMatchObject({ stage: "draft", outcome: null, closedAt: null });
  });

  it("returns null for an anonymous session", async () => {
    const { caseId } = await openCase([aliceFinding]);
    const { scoped: anon } = await anonymousScope(ctx.db);
    expect(await anon.closeCase(caseId, { outcome: "resolved" })).toBeNull();
  });

  it("resolves the findings it named when the outcome is resolved", async () => {
    const second = await seedFinding(ctx.db, aliceInvoice);
    const { scoped, caseId } = await openCase([aliceFinding, second]);

    await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 5_000 });
    const rows = await ctx.db.select().from(findings).where(inArray(findings.id, [aliceFinding, second]));
    expect(rows.map((r) => r.status)).toEqual(["resolved", "resolved"]);
  });

  // Decision 4: `partial` goes to `unresolved`, not `resolved`. The case
  // never records *which* findings the partial recovery covered, so calling
  // them all resolved would hide money from the report that nobody got back.
  it.each(["partial", "denied", "abandoned"] as const)(
    "leaves the findings unresolved when the outcome is %s",
    async (outcome) => {
      const { scoped, caseId } = await openCase([aliceFinding]);
      await scoped.closeCase(caseId, { outcome, recoveredCents: outcome === "partial" ? 1_000 : 0 });

      const [row] = await ctx.db.select().from(findings).where(eq(findings.id, aliceFinding));
      expect(row?.status).toBe("unresolved");
    },
  );

  it("leaves a named finding alone once it is no longer contested", async () => {
    const second = await seedFinding(ctx.db, aliceInvoice);
    const { scoped, caseId } = await openCase([aliceFinding, second]);
    // Something else already settled this one - only findings still
    // `contested` by this case are the case's to move.
    await ctx.db.update(findings).set({ status: "dismissed_by_user" }).where(eq(findings.id, second));

    await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 5_000 });
    const [untouched] = await ctx.db.select().from(findings).where(eq(findings.id, second));
    expect(untouched?.status).toBe("dismissed_by_user");
  });

  it("does not touch findings of another case that shares the invoice", async () => {
    const otherFinding = await seedFinding(ctx.db, aliceInvoice);
    const { scoped, caseId } = await openCase([aliceFinding]);
    const otherCase = await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [otherFinding] });
    expect(otherCase).toEqual(expect.any(String));

    await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 5_000 });
    const [stillOpen] = await ctx.db.select().from(findings).where(eq(findings.id, otherFinding));
    expect(stillOpen?.status).toBe("contested");
  });
});
