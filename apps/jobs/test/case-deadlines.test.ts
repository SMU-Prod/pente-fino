import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectExpiredDeadlines, computeDeadline, newId, toCivilDate,
  type EventType, type Stage,
} from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createCaseDeadlinesTask } from "../src/tasks/case-deadlines.js";

const { caseProtocols, cases, events, invoices, issuers, users } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed reference instant, never the real wall clock: every date below is
// computed relative to it, and it is the only value ever passed as
// `payload.now`. 2026-08-31 is a Monday; 12:00Z is 09:00 in São Paulo.
const NOW = new Date("2026-08-31T12:00:00.000Z");

// The 30-day protocol window every escalation and every stall restarts,
// computed by the same function the job uses rather than restated as a
// literal - the point of the assertion is that the job stamps RF-186's
// window, not that we can both do the same date arithmetic.
const PROTOCOL_WINDOW_FROM_NOW =
  computeDeadline({ startedAt: NOW, days: 30, businessDays: false }).expiresAt;

let ctx: TestDb;
let telecomIssuerId: string;
let userId: string;
let invoiceId: string;

function task(db = ctx.db) {
  return createCaseDeadlinesTask({ db });
}

async function insertIssuer(category: "telecom" | "card"): Promise<string> {
  const id = newId("iss");
  await ctx.db.insert(issuers).values({
    id, slug: `${id}-slug`, category, displayName: `${category} issuer`,
  });
  return id;
}

async function insertCase(overrides: {
  stage?: Stage;
  nextDeadlineAt?: Date | null;
  stageEnteredAt?: Date;
  createdAt?: Date;
  issuerId?: string;
} = {}): Promise<string> {
  const id = newId("cas");
  await ctx.db.insert(cases).values({
    id,
    userId,
    invoiceId,
    issuerId: overrides.issuerId ?? telecomIssuerId,
    findingIds: [],
    stage: overrides.stage ?? "sac",
    stageEnteredAt: overrides.stageEnteredAt ?? new Date(NOW.getTime() - 8 * DAY_MS),
    nextDeadlineAt: overrides.nextDeadlineAt === undefined
      ? new Date(NOW.getTime() - DAY_MS)
      : overrides.nextDeadlineAt,
    createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 8 * DAY_MS),
  });
  return id;
}

async function insertProtocol(
  caseId: string, stage: Stage, protocolNumber = "SAC-11223344", registeredAt?: Date,
): Promise<void> {
  const at = registeredAt ?? new Date(NOW.getTime() - 8 * DAY_MS);
  await ctx.db.insert(caseProtocols).values({
    id: newId("prt"), caseId, stage, protocolNumber, channel: "canal",
    registeredAt: at,
    responseDueAt: registeredAt
      ? computeDeadline({ startedAt: at, days: 7, businessDays: false }).expiresAt
      : new Date(NOW.getTime() - DAY_MS),
  });
}

async function insertEvent(caseId: string, type: EventType, occurredAt: Date): Promise<void> {
  await ctx.db.insert(events).values({
    id: newId("evt"), caseId, userId, invoiceId, type, occurredAt,
  });
}

/**
 * A `Database` that lets somebody else write between this run's scan and its
 * update — the race the optimistic guard exists for.
 *
 * The interception point is `transaction`, because that is where the guarded
 * `UPDATE` lives: by the time the callback runs, the competing write has
 * already committed, so the guard's `WHERE` re-evaluates against a row that
 * no longer matches what the scan saw. Methods are bound to the real
 * database rather than the proxy so drizzle's internals are untouched.
 */
function racingDb(db: TestDb["db"], compete: () => Promise<void>): TestDb["db"] {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return async (...args: unknown[]) => {
          await compete();
          return (target.transaction as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function caseRow(id: string) {
  const [row] = await ctx.db.select().from(cases).where(eq(cases.id, id));
  if (!row) throw new Error(`case ${id} vanished`);
  return row;
}

async function eventsFor(id: string) {
  return ctx.db.select().from(events).where(eq(events.caseId, id));
}

async function typesFor(id: string): Promise<string[]> {
  return (await eventsFor(id)).map((row) => row.type);
}

beforeEach(async () => {
  ctx = await createTestDb();
  // createTestDb seeds §20.1's six telecom issuers and (since E5 Task 2)
  // §20.2's playbook onto each, so reuse the seeded row rather than
  // inventing a second claro-movel.
  const [seeded] = await ctx.db
    .select({ id: issuers.id })
    .from(issuers)
    .where(eq(issuers.slug, "claro-movel"));
  if (!seeded) throw new Error("expected createTestDb to seed the claro-movel issuer");
  telecomIssuerId = seeded.id;

  userId = newId("usr");
  await ctx.db.insert(users).values({ id: userId, email: `${userId}@example.com` });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, userId, issuerId: telecomIssuerId, contentHash: invoiceId, source: "pdf_text",
  });
});

afterEach(async () => {
  await ctx.close();
});

describe("case-deadlines task: an expired deadline (RF-180, §9.1)", () => {
  it("escalates a telecom case out of sac to consumidor_gov when the channel let its own deadline pass", async () => {
    const caseId = await insertCase({ stage: "sac" });
    await insertProtocol(caseId, "sac");

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("consumidor_gov");
    expect(row.nextDeadlineAt?.getTime()).toBe(PROTOCOL_WINDOW_FROM_NOW.getTime());
    expect(await typesFor(caseId)).toEqual(
      expect.arrayContaining(["deadline_expired", "stage_advanced"]),
    );
  });

  it("escalates a card case out of sac to the ombudsman instead, the one conditional edge in §9.1", async () => {
    const cardIssuerId = await insertIssuer("card");
    const caseId = await insertCase({ stage: "sac", issuerId: cardIssuerId });
    await insertProtocol(caseId, "sac");

    await task()({ now: NOW.toISOString() });

    expect((await caseRow(caseId)).stage).toBe("ombudsman");
  });

  it("leaves a deadline still in the future alone, and writes nothing at all for it", async () => {
    const future = new Date(NOW.getTime() + 5 * DAY_MS);
    const caseId = await insertCase({ stage: "sac", nextDeadlineAt: future });
    await insertProtocol(caseId, "sac");

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("sac");
    expect(row.nextDeadlineAt?.getTime()).toBe(future.getTime());
    expect(await eventsFor(caseId)).toHaveLength(0);
  });

  it("never touches a closed case, even one whose deadline is long past", async () => {
    const caseId = await insertCase({
      stage: "closed",
      nextDeadlineAt: new Date(NOW.getTime() - 40 * DAY_MS),
      createdAt: new Date(NOW.getTime() - 200 * DAY_MS),
    });

    await task()({ now: NOW.toISOString() });

    expect((await caseRow(caseId)).stage).toBe("closed");
    expect(await eventsFor(caseId)).toHaveLength(0);
  });

  it("is idempotent: a second run in a row writes no second set of events", async () => {
    const caseId = await insertCase({ stage: "sac" });
    await insertProtocol(caseId, "sac");

    const run = task();
    await run({ now: NOW.toISOString() });
    await run({ now: NOW.toISOString() });

    const types = await typesFor(caseId);
    expect(types.filter((t) => t === "deadline_expired")).toHaveLength(1);
    expect(types.filter((t) => t === "stage_advanced")).toHaveLength(1);
  });

  it("does not let one case's failure sink the run for the others (A8)", async () => {
    // An ops row filled in wrong: `stages` is not an array, so §9.1's table
    // throws the moment it looks a stage up. `regulator` is the stage that
    // reads the playbook (it decides whether `procon` is declared).
    const brokenIssuerId = await insertIssuer("telecom");
    await ctx.db.execute(
      sql`update issuers set playbook = '{"stages":"not-an-array"}'::jsonb where id = ${brokenIssuerId}`,
    );
    const brokenCaseId = await insertCase({ stage: "regulator", issuerId: brokenIssuerId });
    await insertProtocol(brokenCaseId, "regulator");
    const healthyCaseId = await insertCase({ stage: "sac" });
    await insertProtocol(healthyCaseId, "sac");

    await expect(task()({ now: NOW.toISOString() })).resolves.toBeUndefined();

    expect((await caseRow(brokenCaseId)).stage).toBe("regulator");
    expect((await caseRow(healthyCaseId)).stage).toBe("consumidor_gov");
  });

  it("writes nothing when another writer moves the case between the scan and the update (A4)", async () => {
    const caseId = await insertCase({ stage: "sac" });
    await insertProtocol(caseId, "sac");

    // A second job instance, or a user posting a protocol, lands first.
    // `regulator` deliberately, and not `consumidor_gov`: that is the stage
    // this sweep would itself have written (telecom escalates `sac →
    // consumidor_gov`), so a stage assertion against it would still pass with
    // the guard deleted, and half the test would be passing by coincidence.
    // A stage the sweeper could never produce here makes both assertions
    // discriminating.
    const db = racingDb(ctx.db, async () => {
      await ctx.db.update(cases).set({ stage: "regulator" }).where(eq(cases.id, caseId));
    });

    await createCaseDeadlinesTask({ db })({ now: NOW.toISOString() });

    // The winner's write stands untouched, and the loser wrote no events at
    // all — not a second `deadline_expired`, not a `stage_advanced` claiming
    // a move it did not make.
    expect((await caseRow(caseId)).stage).toBe("regulator");
    expect(await eventsFor(caseId)).toHaveLength(0);
  });

  it("rolls the stage change back when its event cannot be written, so the two can never disagree (A3)", async () => {
    const caseId = await insertCase({ stage: "sac" });
    await insertProtocol(caseId, "sac");
    // Make the transaction's *last* write fail, after the case row has been
    // updated and `deadline_expired` inserted. A real constraint rather than
    // a stub, so what is exercised is the database's own rollback.
    await ctx.db.execute(
      sql`alter table events add constraint events_no_stage_advanced check (type <> 'stage_advanced')`,
    );
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    let failuresLogged = 0;

    try {
      await task()({ now: NOW.toISOString() });
      // Read before restoring: `mockRestore` resets the call history as well
      // as the implementation, so asserting on the spy afterwards asserts on
      // an already-cleared record.
      failuresLogged = reported.mock.calls.length;
    } finally {
      reported.mockRestore();
    }

    const row = await caseRow(caseId);
    expect(row.stage).toBe("sac");
    expect(row.nextDeadlineAt?.getTime()).toBe(NOW.getTime() - DAY_MS);
    // No orphan `deadline_expired` either: a stage that advanced with no
    // event, or an event for an advance that did not happen, are the same
    // defect from two sides, and A3 forbids both.
    expect(await eventsFor(caseId)).toHaveLength(0);
    expect(failuresLogged).toBe(1); // and the run reported it rather than swallowing it
  });
});

describe("case-deadlines task: RF-186's stall", () => {
  it("returns a sac case with no protocol to sac and restarts the 30-day window", async () => {
    const caseId = await insertCase({ stage: "sac" });

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("sac");
    expect(row.nextDeadlineAt?.getTime()).toBe(PROTOCOL_WINDOW_FROM_NOW.getTime());
    expect(await typesFor(caseId)).toContain("case_stalled");
  });

  it("writes no stage_advanced when the stall did not move the stage, because that payload would be a lie", async () => {
    const caseId = await insertCase({ stage: "sac" });

    await task()({ now: NOW.toISOString() });

    // Asserted as the *whole* set, not just the absence: an assertion that
    // only says `not.toContain` is one a do-nothing handler also satisfies,
    // so it needs the two rows that prove the sweep actually ran beside it.
    // Sorted because the query has no ORDER BY.
    expect([...await typesFor(caseId)].sort()).toEqual(["case_stalled", "deadline_expired"]);
  });

  it("stalls a regulator case that has a sac protocol but none for regulator, since hasProtocol is per-stage", async () => {
    const caseId = await insertCase({ stage: "regulator" });
    await insertProtocol(caseId, "sac"); // a protocol, but not for the channel it is sitting in

    await task()({ now: NOW.toISOString() });

    expect((await caseRow(caseId)).stage).toBe("sac");
    const types = await typesFor(caseId);
    // The stage really did move, so both are true at once.
    expect(types).toContain("case_stalled");
    expect(types).toContain("stage_advanced");
  });
});

describe("case-deadlines task: the deadline_expired payload (RF-182's raw material)", () => {
  it("records the protocol number, the channel and both civil dates as facts, not as keys", async () => {
    const stageEnteredAt = new Date(NOW.getTime() - 8 * DAY_MS);
    const deadlineAt = new Date(NOW.getTime() - DAY_MS);
    const caseId = await insertCase({ stage: "sac", stageEnteredAt, nextDeadlineAt: deadlineAt });
    await insertProtocol(caseId, "sac", "SAC-99887766");

    await task()({ now: NOW.toISOString() });

    const [expiry] = (await eventsFor(caseId)).filter((row) => row.type === "deadline_expired");
    expect(expiry?.payload).toMatchObject({
      stage: "sac",
      protocolNumber: "SAC-99887766",
      channel: "SAC da operadora",
      deadlineAt: deadlineAt.toISOString(),
      observedAt: NOW.toISOString(),
      stageEnteredAt: stageEnteredAt.toISOString(),
      deadlineDate: toCivilDate(deadlineAt),
      stageEnteredDate: toCivilDate(stageEnteredAt),
      hasProtocol: true,
      stalled: false,
      playbookMissing: false,
    });
  });

  it("says so out loud when the issuer has no playbook, rather than routing the case in silence", async () => {
    const cardIssuerId = await insertIssuer("card"); // no playbook seeded for card
    const caseId = await insertCase({ stage: "sac", issuerId: cardIssuerId });
    await insertProtocol(caseId, "sac");

    await task()({ now: NOW.toISOString() });

    const [expiry] = (await eventsFor(caseId)).filter((row) => row.type === "deadline_expired");
    expect(expiry?.payload).toMatchObject({ playbookMissing: true, channel: null });
  });

  it("stamps every event it writes with the injected clock, not the wall clock", async () => {
    const escalating = await insertCase({ stage: "sac" });
    await insertProtocol(escalating, "sac");
    const abandoning = await insertCase({
      stage: "sac", nextDeadlineAt: null, createdAt: new Date(NOW.getTime() - 61 * DAY_MS),
    });

    await task()({ now: NOW.toISOString() });

    // Both sweeps, so neither can be the one that got it right by accident.
    // Four rows: `deadline_expired` + `stage_advanced` from the escalation,
    // and `outcome_confirmed` + `stage_advanced` from the close, which
    // `closeCaseAsSystem` writes and which therefore also has to honour the
    // injected instant (that is what its `at` parameter is for).
    const written = [...await eventsFor(escalating), ...await eventsFor(abandoning)];
    expect(written).toHaveLength(4);
    for (const row of written) {
      // `occurred_at` defaulting to now() would put the wall clock in the
      // same row whose payload carries the simulated `observedAt` — two
      // disagreeing timestamps, in the job whose whole point is that time is
      // injected. RF-186's acceptance is a temporal simulation.
      expect(row.occurredAt.getTime()).toBe(NOW.getTime());
    }
  });

  it("correlates every event it writes: caseId, userId and invoiceId are all set", async () => {
    const caseId = await insertCase({ stage: "sac" });
    await insertProtocol(caseId, "sac");

    await task()({ now: NOW.toISOString() });

    for (const row of await eventsFor(caseId)) {
      expect(row.caseId).toBe(caseId);
      expect(row.userId).toBe(userId);
      expect(row.invoiceId).toBe(invoiceId);
    }
  });
});

describe("case-deadlines task: RF-186's abandonment (§9.1's 60 days without user action)", () => {
  it("closes a case nobody has touched for 60 days as abandoned, with an event and no recovered value", async () => {
    const caseId = await insertCase({
      stage: "sac",
      nextDeadlineAt: null, // waiting on the user, so no deadline can expire
      createdAt: new Date(NOW.getTime() - 61 * DAY_MS),
    });

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("closed");
    expect(row.outcome).toBe("abandoned");
    expect(row.outcomeConfirmedBy).toBe("none");
    expect(row.closedAt?.getTime()).toBe(NOW.getTime());
    expect(row.nextDeadlineAt).toBeNull();
    // §1.4's north-star metric counts *confirmed* recovered reais. A case
    // that evaporated recovered nothing anybody confirmed.
    expect(row.recoveredCents).toBeNull();

    // `outcome_confirmed` **is** written, deliberately: `closeCaseAsSystem`
    // writes it for every system close so that A3's promise holds under one
    // rule - every ending is reconstructible from `events` without knowing
    // which terminal event that particular kind of ending happens to use.
    // The cost is real and is recorded in the report: §15.2's funnel ends at
    // this event and §1.4 counts from it, so whoever builds those metrics
    // must exclude `outcome: "abandoned"`.
    const types = await typesFor(caseId);
    expect(types).toContain("stage_advanced");
    expect(types).toContain("outcome_confirmed");
  });

  it("stamps the abandonment as inactivity, not as an expired deadline", async () => {
    const caseId = await insertCase({
      stage: "consumidor_gov",
      nextDeadlineAt: null,
      createdAt: new Date(NOW.getTime() - 61 * DAY_MS),
    });

    await task()({ now: NOW.toISOString() });

    const [advance] = (await eventsFor(caseId)).filter((row) => row.type === "stage_advanced");
    expect(advance?.payload).toMatchObject({
      from: "consumidor_gov", to: "closed", by: "system",
      reason: "inactivity", outcome: "abandoned",
    });
  });

  it("still abandons a case whose only recent events are the ones this job writes itself", async () => {
    const caseId = await insertCase({
      stage: "sac",
      nextDeadlineAt: null,
      createdAt: new Date(NOW.getTime() - 61 * DAY_MS),
    });
    // System events, all of them yesterday. None of them is a user acting:
    // if the allowlist let any of these through, this case would look alive
    // forever and RF-186's second window would never close.
    await insertEvent(caseId, "deadline_expired", new Date(NOW.getTime() - DAY_MS));
    await insertEvent(caseId, "stage_advanced", new Date(NOW.getTime() - DAY_MS));
    await insertEvent(caseId, "monthly_digest_sent", new Date(NOW.getTime() - DAY_MS));
    await insertEvent(caseId, "monitor_email_received", new Date(NOW.getTime() - DAY_MS));

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("closed");
    expect(row.outcome).toBe("abandoned");
  });

  // `case_stalled` is deliberately not in the fixture above any more. It is
  // excluded from the allowlist like the rest of this job's writes, but since
  // F1 it *also* hands the case to the post-stall clock - so one assertion
  // was proving two different things and would have kept passing if either
  // broke. This is the second of them, on its own.
  it("leaves a case that stalled yesterday alone, however long it has been silent (F1)", async () => {
    const caseId = await insertCase({
      stage: "sac",
      nextDeadlineAt: null,
      createdAt: new Date(NOW.getTime() - 200 * DAY_MS),
    });
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - DAY_MS));

    await task()({ now: NOW.toISOString() });

    // 200 days of silence, and the 60-day backstop still steps aside: the
    // stall is current, so RF-186's thirty days of grace own this case and
    // the two clocks do not race.
    const row = await caseRow(caseId);
    expect(row.stage).toBe("sac");
    expect(row.outcome).toBeNull();
  });

  it("resumes the 60-day backstop once a user action has voided the stall", async () => {
    const caseId = await insertCase({
      stage: "sac",
      nextDeadlineAt: null,
      createdAt: new Date(NOW.getTime() - 200 * DAY_MS),
    });
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 100 * DAY_MS));
    // The person came back after the stall, then went quiet again for 90
    // days. The stall they answered is spent, so the backstop applies.
    await insertEvent(caseId, "report_viewed", new Date(NOW.getTime() - 90 * DAY_MS));

    await task()({ now: NOW.toISOString() });

    expect((await caseRow(caseId)).outcome).toBe("abandoned");
  });

  it("does not close a case at day 59 of silence, counting from the user's last action and not from creation", async () => {
    const caseId = await insertCase({
      stage: "sac",
      nextDeadlineAt: null,
      createdAt: new Date(NOW.getTime() - 200 * DAY_MS),
    });
    await insertEvent(caseId, "report_viewed", new Date(NOW.getTime() - 59 * DAY_MS));

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("sac");
    expect(row.outcome).toBeNull();
    expect(await eventsFor(caseId)).toHaveLength(1); // only the report_viewed we inserted
  });

  it("closes on the last allowlisted user action, not only on the created_at fallback", async () => {
    // The mirror of the day-59 test, from the closing side. `createdAt` is
    // deliberately *recent* so the fallback would keep this case open: the
    // only thing that can close it is the `report_viewed` row. A case whose
    // creation postdates its own events cannot happen in production; this is
    // a fixture built to isolate which of the two the clock actually reads.
    const caseId = await insertCase({
      stage: "sac", nextDeadlineAt: null, createdAt: new Date(NOW.getTime() - DAY_MS),
    });
    await insertEvent(caseId, "report_viewed", new Date(NOW.getTime() - 61 * DAY_MS));

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("closed");
    expect(row.outcome).toBe("abandoned");
  });

  it("closes rather than escalates a case that is both expired and abandonment-eligible", async () => {
    const caseId = await insertCase({
      stage: "sac",
      nextDeadlineAt: new Date(NOW.getTime() - DAY_MS),
      createdAt: new Date(NOW.getTime() - 61 * DAY_MS),
    });
    await insertProtocol(caseId, "sac");

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("closed");
    expect(row.outcome).toBe("abandoned");
    expect(await typesFor(caseId)).not.toContain("deadline_expired");
  });
});

describe("case-deadlines task: RF-186's post-stall window (F1)", () => {
  /**
   * The whole of F1 in one timeline. Every instant is derived from the row
   * the sweeper actually stamped, never from a literal `t0 + 67`: the
   * protocol window rolls forward to a business day, so a hardcoded
   * expectation would pass for the wrong reason and break the day a holiday
   * moves.
   */
  it("closes a stalled case on its post-stall window, not on the 60-day inactivity backstop", async () => {
    const t0 = new Date("2026-06-01T12:00:00.000Z");
    const caseId = await insertCase({
      stage: "sac",
      stageEnteredAt: t0,
      createdAt: t0,
      nextDeadlineAt: computeDeadline({ startedAt: t0, days: 7, businessDays: false }).expiresAt,
    });
    await insertProtocol(caseId, "sac", "SAC-1", t0);
    const run = task();

    // 1. The SAC deadline passes with the channel silent, so the case
    //    escalates and the new channel starts on the protocol window.
    const sacDeadline = (await caseRow(caseId)).nextDeadlineAt;
    await run({ now: new Date(sacDeadline!.getTime() + 1) });
    expect((await caseRow(caseId)).stage).toBe("consumidor_gov");

    // 2. Nobody ever writes to that channel, so the window runs out and the
    //    case stalls back to `sac`. This is where the post-stall clock starts.
    const govDeadline = (await caseRow(caseId)).nextDeadlineAt;
    await run({ now: new Date(govDeadline!.getTime() + 1) });
    const stalled = await caseRow(caseId);
    expect(stalled.stage).toBe("sac");
    expect(await typesFor(caseId)).toContain("case_stalled");

    const postStall = stalled.nextDeadlineAt;
    // The discriminator. Day 60 counted from the last user action falls
    // *inside* the post-stall window — it is exactly where the old backstop
    // closed this case — so a run here must leave it open.
    const day60 = new Date(t0.getTime() + 60 * DAY_MS);
    expect(day60.getTime()).toBeLessThan(postStall!.getTime());

    await run({ now: day60 });
    const atDay60 = await caseRow(caseId);
    expect(atDay60.stage).toBe("sac");
    expect(atDay60.outcome).toBeNull();

    // 3. The post-stall window runs out. Now it closes — and the payload
    //    says which of the two clocks did it, because "the person went quiet
    //    without ever stalling" and "the stall ran out" are different stories
    //    and RF-187's dossier is read by a judge.
    await run({ now: new Date(postStall!.getTime() + 1) });
    const closed = await caseRow(caseId);
    expect(closed.stage).toBe("closed");
    expect(closed.outcome).toBe("abandoned");
    expect(closed.recoveredCents).toBeNull();

    const advance = (await eventsFor(caseId)).filter((row) => row.type === "stage_advanced").pop();
    expect(advance?.payload).toMatchObject({ reason: "stall_expired", outcome: "abandoned" });
  }, 60_000);

  it("does not abandon a case whose owner keeps clicking escalate, and closes it thirty days after the last click", async () => {
    const t0 = new Date("2026-06-01T12:00:00.000Z");
    const caseId = await insertCase({
      stage: "sac", stageEnteredAt: t0, createdAt: t0,
      nextDeadlineAt: computeDeadline({ startedAt: t0, days: 30, businessDays: false }).expiresAt,
    });
    const scoped = withUser({ userId }, ctx.db);
    const run = task();

    // Somebody with no protocol clicking "escalate agora" every 20 days for
    // four months. §9.1 sends every one of those back to `sac` — it is the
    // stall — so before Task 3 added the `case_stalled` write, none of them
    // left a single row in `events`.
    let clickedAt = t0;
    for (let click = 0; click < 6; click += 1) {
      clickedAt = new Date(clickedAt.getTime() + 20 * DAY_MS);
      await scoped.advanceCase(caseId, { reason: "user_request" });
      await run({ now: clickedAt });
      // Half one: the person is visibly using the product, so nothing may
      // close their case. The 60-day backstop counting from `created_at`
      // would have closed it on the fourth click.
      expect((await caseRow(caseId)).stage).not.toBe("closed");
    }

    // Half two: they stop. The case closes on the window the *last* click
    // restarted, which is RF-186's 30 days of grace — not instantly, and not
    // counted from an event four months old.
    const lastWindow = (await caseRow(caseId)).nextDeadlineAt;
    await run({ now: new Date(lastWindow!.getTime() - DAY_MS) });
    expect((await caseRow(caseId)).stage).not.toBe("closed");

    await run({ now: new Date(lastWindow!.getTime() + 1) });
    const closed = await caseRow(caseId);
    expect(closed.stage).toBe("closed");
    expect(closed.outcome).toBe("abandoned");
  }, 120_000);
});

describe("case-deadlines task: the contract with Task 5's document (RF-182)", () => {
  it("writes deadline_expired rows that collectExpiredDeadlines can pair with the case's protocols", async () => {
    const stageEnteredAt = new Date(NOW.getTime() - 8 * DAY_MS);
    const caseId = await insertCase({ stage: "sac", stageEnteredAt });
    await insertProtocol(caseId, "sac", "SAC-77001122");

    await task()({ now: NOW.toISOString() });

    // The real rows, fed to the real function: this is the only assertion
    // anywhere that joins the sweeper's payload to the document that reads
    // it, so a rename on either side has to break a test rather than
    // silently emptying RF-182's escalation section.
    const protocolRows = await ctx.db.select().from(caseProtocols)
      .where(eq(caseProtocols.caseId, caseId));
    const eventRows = await eventsFor(caseId);
    const expired = collectExpiredDeadlines({
      protocols: protocolRows.map((row) => ({
        stage: row.stage,
        protocolNumber: row.protocolNumber,
        channel: row.channel,
        registeredAt: row.registeredAt,
        responseDueAt: row.responseDueAt,
      })),
      events: eventRows.map((row) => ({
        type: row.type, occurredAt: row.occurredAt, payload: row.payload,
      })),
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      stage: "sac",
      protocolNumber: "SAC-77001122",
      registeredAt: new Date(NOW.getTime() - 8 * DAY_MS),
      expiredAt: new Date(NOW.getTime() - DAY_MS),
    });
  });
});

describe("case-deadlines task: the wait survives a restart (RF-180)", () => {
  it("advances a case persisted before a simulated redeploy, rebuilt from the database alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-restart-"));
    try {
      // --- connection A: persist the wait, and nothing else. ---
      let first: TestDb | null = await createTestDb({ dataDir: dir });
      const [seeded] = await first.db
        .select({ id: issuers.id }).from(issuers).where(eq(issuers.slug, "claro-movel"));
      if (!seeded) throw new Error("expected the file-backed database to be seeded too");

      const restartUserId = newId("usr");
      const restartInvoiceId = newId("inv");
      const restartCaseId = newId("cas");
      await first.db.insert(users)
        .values({ id: restartUserId, email: `${restartUserId}@example.com` });
      await first.db.insert(invoices).values({
        id: restartInvoiceId, userId: restartUserId, issuerId: seeded.id,
        contentHash: restartInvoiceId, source: "pdf_text",
      });
      await first.db.insert(cases).values({
        id: restartCaseId, userId: restartUserId, invoiceId: restartInvoiceId,
        issuerId: seeded.id, findingIds: [], stage: "sac",
        stageEnteredAt: new Date(NOW.getTime() - 8 * DAY_MS),
        nextDeadlineAt: new Date(NOW.getTime() - DAY_MS),
        createdAt: new Date(NOW.getTime() - 8 * DAY_MS),
      });
      await first.db.insert(caseProtocols).values({
        id: newId("prt"), caseId: restartCaseId, stage: "sac",
        protocolNumber: "SAC-55667788", channel: "canal",
        registeredAt: new Date(NOW.getTime() - 8 * DAY_MS),
        responseDueAt: new Date(NOW.getTime() - DAY_MS),
      });
      // The sweeper is deliberately never run here.

      // --- the redeploy: the database process goes away, every reference
      // is dropped, and the module registry with it, so module-level state
      // cannot survive either. ---
      await first.close();
      first = null;
      vi.resetModules();

      // --- connection B: a fresh module, a fresh database opened from the
      // same directory, fresh deps, a fresh task. ---
      const fresh = await import("../src/tasks/case-deadlines.js");
      const second = await createTestDb({ dataDir: dir });
      try {
        await fresh.createCaseDeadlinesTask({ db: second.db })({ now: NOW.toISOString() });

        const [row] = await second.db.select().from(cases).where(eq(cases.id, restartCaseId));
        expect(row?.stage).toBe("consumidor_gov");
        expect(row?.nextDeadlineAt?.getTime()).toBe(PROTOCOL_WINDOW_FROM_NOW.getTime());

        const written = await second.db.select().from(events).where(eq(events.caseId, restartCaseId));
        expect(written.map((e) => e.type)).toEqual(
          expect.arrayContaining(["deadline_expired", "stage_advanced"]),
        );
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Two full PGlite lifetimes, one of them running every migration and
    // every seed against a real directory on disk. The default 5s is a
    // budget for a test, not for a simulated deploy.
  }, 180_000);
});
