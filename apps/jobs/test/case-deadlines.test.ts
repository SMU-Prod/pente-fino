import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeDeadline, newId, toCivilDate, type EventType, type Stage } from "@pentefino/core";
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
  caseId: string, stage: Stage, protocolNumber = "SAC-11223344",
): Promise<void> {
  await ctx.db.insert(caseProtocols).values({
    id: newId("prt"), caseId, stage, protocolNumber, channel: "canal",
    registeredAt: new Date(NOW.getTime() - 8 * DAY_MS),
    responseDueAt: new Date(NOW.getTime() - DAY_MS),
  });
}

async function insertEvent(caseId: string, type: EventType, occurredAt: Date): Promise<void> {
  await ctx.db.insert(events).values({
    id: newId("evt"), caseId, userId, invoiceId, type, occurredAt,
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

    expect(await typesFor(caseId)).not.toContain("stage_advanced");
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

    const types = await typesFor(caseId);
    expect(types).toContain("stage_advanced");
    expect(types).not.toContain("outcome_confirmed");
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
      from: "consumidor_gov", to: "closed", reason: "inactivity", outcome: "abandoned",
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
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - DAY_MS));
    await insertEvent(caseId, "monthly_digest_sent", new Date(NOW.getTime() - DAY_MS));
    await insertEvent(caseId, "monitor_email_received", new Date(NOW.getTime() - DAY_MS));

    await task()({ now: NOW.toISOString() });

    const row = await caseRow(caseId);
    expect(row.stage).toBe("closed");
    expect(row.outcome).toBe("abandoned");
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
