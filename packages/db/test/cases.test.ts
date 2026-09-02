import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { computeDeadline, newId, PROTOCOL_WINDOW_DAYS, type ContestDocument, type EventType } from "@pentefino/core";
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
  await db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60 * 60_000) });
  return { sessionId, scoped: withUser({ sessionId }, db) };
}

// Every `cases` assertion is scoped to the user under test rather than
// reading the whole table: `createTestDb` runs `seedAll`, and a seed that
// one day ships a case would otherwise turn a dozen unrelated tests red.
const casesOf = (db: TestDb["db"], userId: string) =>
  db.select().from(cases).where(eq(cases.userId, userId));

// Same reason as `casesOf`, and the reason these two exist at all: an event
// assertion filtered on `type` alone reads the whole `events` table, so it
// would count rows written by a seed, by a sibling case, or by the other
// user in this file - and a count of 1 would stop meaning "this case wrote
// exactly one". Scope every event assertion to the case it is about, or to
// the user when the case was never created.
const eventsOfCase = (db: TestDb["db"], caseId: string, type: EventType) =>
  db.select().from(events).where(and(eq(events.caseId, caseId), eq(events.type, type)));

const eventsOfUser = (db: TestDb["db"], userId: string, type: EventType) =>
  db.select().from(events).where(and(eq(events.userId, userId), eq(events.type, type)));

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
  it("opens the case at draft, stamped with the invoice's issuer", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] });
    expect(caseId).toEqual(expect.any(String));

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId!));
    expect(row).toMatchObject({
      userId: alice,
      invoiceId: aliceInvoice,
      issuerId,
      stage: "draft",
      findingIds: [aliceFinding],
      outcome: null,
      closedAt: null,
    });
  });

  // RF-186. This assertion is the reverse of the one E5 Task 4 shipped
  // (`nextDeadlineAt: null`), and the reversal is the point: a null here
  // means Task 3's sweep — which scans `next_deadline_at IS NOT NULL` —
  // never sees the case at all, so the person gets no day-30 nudge and the
  // case is silently abandoned at day 60 with no event. Three tasks each
  // assumed another one stamped this window; nobody did.
  it("starts RF-186's 30-day protocol window, because nothing else ever would", async () => {
    const before = new Date();
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] });

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId!));
    const expected = computeDeadline({
      startedAt: before, days: PROTOCOL_WINDOW_DAYS, businessDays: false,
    });
    expect(row?.nextDeadlineAt).toEqual(expected.expiresAt);
    // Independently of the calculator: the window is thirty-odd days out,
    // not "now" and not never. The upper bound allows for the roll-forward
    // to the next business day (`deadline.ts`'s second decision).
    const days = (row!.nextDeadlineAt!.getTime() - before.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(33.1);
  });

  it("puts the window on the case_created event too, so the trail explains the column", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] });
    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId!));
    const [created] = await eventsOfUser(ctx.db, alice, "case_created");
    expect(created?.payload["nextDeadlineAt"]).toBe(row?.nextDeadlineAt?.toISOString());
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

    const rows = await eventsOfCase(ctx.db, caseId, "case_created");
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
    // No case id to scope to - there is no case. Alice is the next-narrowest
    // scope, and it still excludes Bob's rows and anything a seed wrote.
    expect(await eventsOfUser(ctx.db, alice, "case_created")).toHaveLength(0);
  });

  // The validating SELECT runs outside the transaction, so two callers can
  // both read the same finding as contestable. The invariant is therefore in
  // the write: the flip to `contested` carries the contestability test in its
  // own WHERE and the transaction rolls back unless it touched every finding
  // the case names. Without that, both callers insert and the same money ends
  // up in two live cases - double-counted into §1.4's north-star metric the
  // moment both close.
  //
  // **What this test proves, exactly.** Both calls are issued together, but
  // PGlite runs every transaction under a single mutex
  // (`_runExclusiveTransaction`), so they execute one after the other and no
  // test in this repo can observe the two-transactions-in-flight case at
  // all. What is real here is the *stale SELECT*: the second call's
  // validating SELECT already ran and passed while the finding was still
  // `open`, and by the time its UPDATE runs the winner has flipped it to
  // `contested`, so the UPDATE matches zero rows and the whole transaction
  // rolls back. That is the half that would break first if the hardened
  // WHERE were dropped from the write. The row-lock behaviour described in
  // `createCase`'s doc comment is production Postgres and is reasoned, not
  // tested - do not read this test as evidence for it.
  //
  // The loser gets `null`, not a rejection: contention is not a broken
  // invariant, and the route does not catch, so a throw would be a 500 on
  // exactly the double-clicked submit that gets a clean 404 when it happens
  // sequentially. `allSettled` rather than `all` so a regression to throwing
  // shows up as a failed assertion here rather than as an unhandled rejection.
  it("opens only one case when two calls race for the same finding, and the loser gets null", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const results = await Promise.allSettled([
      scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }),
      scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : "REJECTED"));
    expect(values.filter((v) => typeof v === "string")).toHaveLength(1);
    expect(values.filter((v) => v === null)).toHaveLength(1);

    const opened = await casesOf(ctx.db, alice);
    expect(opened).toHaveLength(1);
    expect(await eventsOfCase(ctx.db, opened[0]!.id, "case_created")).toHaveLength(1);
    expect(await eventsOfUser(ctx.db, alice, "case_created")).toHaveLength(1);
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

  // The fourth status `CONTESTABLE_FINDING_STATUSES` leaves out, and the one
  // the other three tests here had no companion for. A `resolved` finding is
  // money an earlier case already got back: contesting it again would ask a
  // company for a refund it has already made, and its `recoveredCents` would
  // be counted a second time into §1.4's north-star metric when the new case
  // closed.
  it("refuses a resolved finding - that money was already recovered once", async () => {
    const settled = await seedFinding(ctx.db, aliceInvoice, { status: "resolved" });
    const scoped = withUser({ userId: alice }, ctx.db);
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [settled] })).toBeNull();
    expect(await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding, settled] })).toBeNull();
    expect(await casesOf(ctx.db, alice)).toHaveLength(0);
    const [untouched] = await ctx.db.select().from(findings).where(eq(findings.id, settled));
    expect(untouched?.status).toBe("resolved");
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
  // Fixtures sit after the case's own `case_created` row - the one
  // `createCase` writes inside its own transaction - so the timeline
  // assertions below read as "creation first, then what happened next".
  //
  // **The coupling that used to live here, so nobody puts it back.** This was
  // `const T0 = new Date(Date.now() + 60_000)` with `at(minutes)` counting
  // from it, both at the top of this `describe`. A `describe` body runs when
  // vitest *collects* the file, so `T0` froze one minute after collection,
  // while `case_created` is stamped at *execution* time by the `now()` default
  // on `events.occurred_at`. Run this file alone and the two are seconds
  // apart, so `case_created` sorted first and every assertion held. Run
  // `pnpm -w test`, where turbo runs seven packages at once and this suite
  // needs minutes to reach the tests below, and real `now()` had already gone
  // past `at(1)`..`at(3)`: `case_created` sorted *after* the fixtures it is
  // supposed to precede, and the two ordering tests failed. The fixtures must
  // be anchored on the row they are actually compared against, never on the
  // wall clock - the offsets below are minutes from `case_created`, not from
  // "now".
  type At = (minutes: number) => Date;

  // Reads back the `case_created` event `createCase` just wrote and returns an
  // `at()` counting from that exact instant. Every fixture in one test shares
  // a single anchor, which is what keeps the interleaving deliberate.
  async function anchorOn(db: TestDb["db"], caseId: string): Promise<At> {
    const [created] = await eventsOfCase(db, caseId, "case_created");
    if (!created) throw new Error(`no case_created event for case ${caseId}`);
    const t0 = created.occurredAt.getTime();
    return (minutes: number) => new Date(t0 + minutes * 60_000);
  }

  // Every fixture below is inserted in reverse chronological order, so a
  // method that just returns insertion order fails these assertions.
  async function seedTimelineFixtures(db: TestDb["db"], caseId: string, at: At) {
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

  // One document and one protocol on a case that is NOT the one under test.
  // `minutes` is chosen by the caller so the rows interleave with the case
  // under test's own: a list that stopped filtering by `caseId` could then
  // not even come back in the right order, never mind the right length. `at`
  // is therefore the case *under test*'s anchor, not this foreign case's -
  // the interleaving is only meaningful on one shared timeline.
  async function seedForeignFixtures(db: TestDb["db"], caseId: string, tag: string, minutes: number, at: At) {
    await db.insert(caseDocuments).values({
      id: newId("doc"), caseId, stage: "sac", kind: "gov_text", promptVersion: 1,
      body: { ...SAMPLE_BODY, subject: `NOT MINE - ${tag}` }, createdAt: at(minutes),
    });
    await db.insert(caseProtocols).values({
      id: newId("prt"), caseId, stage: "sac", protocolNumber: `P-${tag}`, channel: "web",
      registeredAt: at(minutes), responseDueAt: at(minutes + 60 * 24 * 5),
    });
  }

  it("returns documents, protocols and the timeline in chronological order", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    const at = await anchorOn(ctx.db, caseId);
    await seedTimelineFixtures(ctx.db, caseId, at);
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
  // caller's own `ownsEvent` predicate, because ownership was already proved
  // on the case itself one query earlier.
  //
  // What this pins is the **property** - a row carrying this `caseId` is on
  // this case's timeline whether or not it also carries a `userId` - and not
  // a claim about any particular writer. Do not rewrite it as "this is how
  // E5 Task 3's deadline job writes its rows": that job's `record()` helper
  // stamps `userId` alongside `caseId` and `invoiceId`, so the claim would be
  // false, and the next person to check it would "fix" the discrepancy by
  // adding the `ownsEvent` filter this test exists to forbid. `events.user_id`
  // is nullable and no writer is obliged to fill it; that is enough.
  it("includes a system event written with a caseId but no userId", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    const at = await anchorOn(ctx.db, caseId);
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
    // The case under test's own creation instant. The sibling was created a
    // few milliseconds later, which is nowhere near a minute, so every offset
    // below still lands after both `case_created` rows.
    const at = await anchorOn(ctx.db, caseId);
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

  // The same hole the timeline test above closed, in the two lists that
  // carry the actual contents of a dispute. `eq(caseDocuments.caseId, ...)`
  // and `eq(caseProtocols.caseId, ...)` were the only scoping on either
  // list, and until this test nothing in the repo went red if you deleted
  // one: every other `caseDetail` test seeds documents and protocols for a
  // single case, so "every row in the table" and "this case's rows" were the
  // same set. Delete either `.where(...)` and this returns another person's
  // letters and their protocol numbers - the two things in a case that
  // identify who is disputing what, with whom.
  //
  // Three cases, chosen so neither ownership nor the caller's identity can
  // stand in for the filter: the case under test, a *sibling* owned by the
  // same person (which `cases.userId` would not separate), and one owned by
  // Bob (which nothing in these two queries mentions at all).
  it("scopes documents and protocols to its own case, against a sibling and another user's", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const siblingFinding = await seedFinding(ctx.db, aliceInvoice);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    const siblingCaseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [siblingFinding] }))!;
    const strangerCaseId = (await withUser({ userId: bob }, ctx.db)
      .createCase({ invoiceId: bobInvoice, findingIds: [bobFinding] }))!;

    const at = await anchorOn(ctx.db, caseId);
    await seedTimelineFixtures(ctx.db, caseId, at);
    // at(15) lands between this case's two documents; at(35) between its two
    // protocols. Both would be interleaved into the returned lists, not
    // appended, if the scoping went away - which is why all three cases are
    // seeded off the case under test's anchor rather than their own.
    await seedForeignFixtures(ctx.db, siblingCaseId, "SIBLING", 15, at);
    await seedForeignFixtures(ctx.db, strangerCaseId, "STRANGER", 35, at);

    const detail = await scoped.caseDetail(caseId);

    expect(detail?.documents.map((d) => d.caseId)).toEqual([caseId, caseId]);
    expect(detail?.documents.map((d) => d.kind)).toEqual(["contest_letter", "sac_script"]);
    expect(detail?.documents.map((d) => d.body.subject)).toEqual([SAMPLE_BODY.subject, SAMPLE_BODY.subject]);

    expect(detail?.protocols.map((p) => p.caseId)).toEqual([caseId, caseId]);
    expect(detail?.protocols.map((p) => p.protocolNumber)).toEqual(["P-1", "P-2"]);
  });

  it("returns exactly the same value for another user's case and for a case that does not exist", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    await seedTimelineFixtures(ctx.db, caseId, await anchorOn(ctx.db, caseId));

    const other = withUser({ userId: bob }, ctx.db);
    const notMine = await other.caseDetail(caseId);
    const notThere = await other.caseDetail(newId("cas"));
    expect(notMine).toBeNull();
    expect(notMine).toEqual(notThere);
  });

  // **This does not gate the `!userId` guard, and should not be read as if
  // it did.** The guard is not mutation-testable here: `userId` is `string |
  // null` inside `withUser`, and every query in `caseDetail` scopes on
  // `eq(cases.userId, userId)`, so deleting the guard does not compile and
  // the mutant can never be run. Only `createCase`'s version of this test
  // gates its own guard - there the mutant *does* typecheck, because the
  // insert's `userId` field would reach the NOT NULL column and throw a 500
  // where INV-008 requires the same `null` every other rejection gets. What
  // this pins is the contract, which is worth pinning on its own: an
  // anonymous session gets exactly what a stranger gets.
  it("returns null for an anonymous session, whatever the caseId", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    const { scoped: anon } = await anonymousScope(ctx.db);
    expect(await anon.caseDetail(caseId)).toBeNull();
  });

  // `occurred_at`, `created_at` and `registered_at` all default to `now()`,
  // which in Postgres is the *transaction's* start time rather than the
  // statement's - so any writer emitting two rows in one transaction stamps
  // them with the same instant. That is not a freak case: E5 Task 3's
  // deadline job writes `deadline_expired` and `stage_advanced` together,
  // and `closeCase` writes `outcome_confirmed` and `stage_advanced`
  // together. Ordered on the timestamp alone, tied rows come back in
  // whatever order the plan happens to produce, and change order when the
  // plan does - so a person's history would silently rearrange itself.
  //
  // Each pair below is inserted in the order the `id` tiebreak reverses, so
  // a list that returned insertion order (which is what an unordered scan of
  // a freshly written table gives) fails. The claim is determinism, not
  // chronology: ids are random, so the tiebreak fixes *an* order, and the
  // point is that it is always the same one.
  it("returns tied timestamps in a stable order, in all three lists", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const caseId = (await scoped.createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
    const at = await anchorOn(ctx.db, caseId);

    await ctx.db.insert(caseDocuments).values([
      { id: "doc_zz_written_first", caseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY, createdAt: at(10) },
      { id: "doc_aa_written_second", caseId, stage: "sac", kind: "gov_text", promptVersion: 1, body: SAMPLE_BODY, createdAt: at(10) },
    ]);
    await ctx.db.insert(caseProtocols).values([
      {
        id: "prt_zz_written_first", caseId, stage: "sac", protocolNumber: "P-1", channel: "web",
        registeredAt: at(20), responseDueAt: at(20 + 60 * 24 * 5),
      },
      {
        id: "prt_aa_written_second", caseId, stage: "sac", protocolNumber: "P-2", channel: "web",
        registeredAt: at(20), responseDueAt: at(20 + 60 * 24 * 5),
      },
    ]);
    // The pair E5 Task 3's deadline job writes, with the single `occurredAt`
    // one transaction would give them.
    await ctx.db.insert(events).values([
      { id: "evt_zz_written_first", caseId, type: "deadline_expired", payload: {}, occurredAt: at(30) },
      { id: "evt_aa_written_second", caseId, type: "stage_advanced", payload: {}, occurredAt: at(30) },
    ]);

    const detail = await scoped.caseDetail(caseId);
    expect(detail?.documents.map((d) => d.id)).toEqual(["doc_aa_written_second", "doc_zz_written_first"]);
    expect(detail?.protocols.map((p) => p.id)).toEqual(["prt_aa_written_second", "prt_zz_written_first"]);
    expect(detail?.timeline.map((e) => e.id)).toEqual([
      (await eventsOfCase(ctx.db, caseId, "case_created"))[0]!.id,
      "evt_aa_written_second",
      "evt_zz_written_first",
    ]);
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

  // JSON has no `undefined`: "no amount" reaches a body as `null` at least as
  // often as by omission. The integer guard used to fire on the explicit
  // `null` while `?? 0` two lines below would have accepted it, so the same
  // intention expressed two ways got a 500 one way and a normal close the
  // other. `null` is now exactly an absent value.
  it("treats an explicit null recoveredCents as absent, not as a bad argument", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    const closed = await scoped.closeCase(caseId, { outcome: "denied", recoveredCents: null });
    expect(closed?.recoveredCents).toBe(0);
    expect(closed?.stage).toBe("closed");
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
    expect(await eventsOfCase(ctx.db, caseId, "outcome_confirmed")).toHaveLength(0);
  });

  // A3, and unrepairable if left to the route: the close is one-shot, so a
  // crash between a committed close and a route-written event would leave a
  // closed case whose `outcome_confirmed` can never be written - the retry
  // hits `isNull(closedAt)` and returns `null`.
  it("writes exactly one outcome_confirmed event, carrying the outcome and the money recovered", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await scoped.closeCase(caseId, { outcome: "partial", recoveredCents: 4_200 });

    const rows = await eventsOfCase(ctx.db, caseId, "outcome_confirmed");
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

    expect(await eventsOfCase(ctx.db, caseId, "outcome_confirmed")).toHaveLength(1);
    expect(await eventsOfCase(ctx.db, caseId, "stage_advanced")).toHaveLength(1);
  });

  // A close is a stage transition too, and E5 Task 3's abandonment sweep
  // records `stage_advanced` for exactly this column change. If a user close
  // wrote only `outcome_confirmed`, one case's history would have a
  // `stage_advanced` for its move to `closed` and another's would not,
  // depending on who closed it - and E6, told by Task 2's
  // `next-stage.table.ts` to recover a case's pre-close stage from "the last
  // `stage_advanced`" (RF-203), would be right about half of them.
  it("records the stage it left as a stage_advanced event, beside the outcome", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await ctx.db.update(cases).set({ stage: "sac" }).where(eq(cases.id, caseId));

    await scoped.closeCase(caseId, { outcome: "resolved", recoveredCents: 7_700 });

    const advanced = await eventsOfCase(ctx.db, caseId, "stage_advanced");
    expect(advanced).toHaveLength(1);
    expect(advanced[0]).toMatchObject({ userId: alice, invoiceId: aliceInvoice, caseId });
    // `from` is the stage the case actually left, not the stage it is in now
    // - it is the whole reason this row exists.
    expect(advanced[0]?.payload).toEqual({ from: "sac", to: "closed", by: "user", outcome: "resolved" });

    // Exactly one of each, and neither replaces the other: `outcome_confirmed`
    // says how the dispute ended, `stage_advanced` says which stage it left.
    expect(await eventsOfCase(ctx.db, caseId, "outcome_confirmed")).toHaveLength(1);
  });

  // Nothing in the schema pairs `stage = 'closed'` with a non-null
  // `closed_at`: they are two independent columns, and only `closeCase`
  // happens to write both. `nextStage` returns `stage: "closed"` with an
  // outcome for its `resolved` and `user_abandon` events, and E5 Task 5's
  // `/advance` route applies what it returns - so an advance that writes the
  // stage and the outcome without stamping `closed_at` produces a case that
  // is closed by every reading except a guard that only tests `closed_at`.
  // Closing it again would emit a second `outcome_confirmed` and count the
  // same recovery twice into §1.4's north-star metric.
  it("refuses a case already at stage closed, even with closed_at still null", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await ctx.db.update(cases)
      .set({ stage: "closed", outcome: "resolved", outcomeConfirmedBy: "diff", recoveredCents: 3_000 })
      .where(eq(cases.id, caseId));

    expect(await scoped.closeCase(caseId, { outcome: "partial", recoveredCents: 4_200 })).toBeNull();

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));
    expect(row).toMatchObject({ stage: "closed", outcome: "resolved", recoveredCents: 3_000, closedAt: null });
    expect(await eventsOfCase(ctx.db, caseId, "outcome_confirmed")).toHaveLength(0);
    expect(await eventsOfCase(ctx.db, caseId, "stage_advanced")).toHaveLength(0);
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

    const [row] = await eventsOfCase(ctx.db, caseId, "outcome_confirmed");
    expect(row?.payload.note).toBe("Atendente confirmou o estorno, CPF [CPF] conferido no protocolo");
    expect(JSON.stringify(row?.payload)).not.toContain("123.456.789-09");
  });

  it("carries no note key at all when the person did not write one", async () => {
    const { scoped, caseId } = await openCase([aliceFinding]);
    await scoped.closeCase(caseId, { outcome: "denied" });

    const [row] = await eventsOfCase(ctx.db, caseId, "outcome_confirmed");
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

  // Same caveat as `caseDetail`'s: this pins the contract, not the guard.
  // `userId` is `string | null` inside `withUser` and the UPDATE scopes on
  // `eq(cases.userId, userId)`, so a build without the `!userId`
  // short-circuit does not typecheck and the mutant cannot be run. Only
  // `createCase`'s anonymous-session test gates its own guard, because there
  // the mutant compiles and reaches `cases.user_id` NOT NULL.
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
