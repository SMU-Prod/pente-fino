import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { newId, type EventType } from "@pentefino/core";
import type { Mailer } from "@pentefino/core/ports";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createCaseRemindersTask, SUPPRESSION_WINDOW_HOURS } from "../src/tasks/case-reminders.js";

const { cases, events, invoices, issuers, users } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-09-02T12:00:00.000Z");
const APP = "https://pente-fino.example";

let ctx: TestDb;
let issuerId: string;
let userId: string;
let invoiceId: string;
let sent: Array<{ to: string; subject: string; body: string }>;

function mailer(): Mailer {
  return {
    async send(message) {
      sent.push(message);
    },
  };
}

function task(overrides: { mailer?: Mailer } = {}) {
  return createCaseRemindersTask({
    db: ctx.db,
    mailer: overrides.mailer ?? mailer(),
    appBaseUrl: APP,
  });
}

async function insertCase(overrides: { closed?: boolean } = {}): Promise<string> {
  const id = newId("cas");
  await ctx.db.insert(cases).values({
    id,
    userId,
    invoiceId,
    issuerId,
    findingIds: [],
    stage: overrides.closed ? "closed" : "sac",
    ...(overrides.closed ? { closedAt: new Date(NOW.getTime() - DAY_MS), outcome: "abandoned" } : {}),
  });
  return id;
}

async function insertEvent(
  caseId: string, type: EventType, occurredAt: Date, payload: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.insert(events).values({
    id: newId("evt"), caseId, userId, invoiceId, type, payload, occurredAt,
  });
}

async function reminderEvents(caseId: string) {
  const rows = await ctx.db.select().from(events).where(eq(events.caseId, caseId));
  return rows.filter((row) => row.type === "case_reminder_sent");
}

beforeEach(async () => {
  ctx = await createTestDb();
  sent = [];
  const [seeded] = await ctx.db.select({ id: issuers.id }).from(issuers)
    .where(eq(issuers.slug, "claro-movel"));
  if (!seeded) throw new Error("expected createTestDb to seed the claro-movel issuer");
  issuerId = seeded.id;

  userId = newId("usr");
  await ctx.db.insert(users).values({ id: userId, email: `${userId}@example.com` });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, userId, issuerId, contentHash: invoiceId, source: "pdf_text",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.close();
});

describe("RF-185: the reminder itself", () => {
  it("mails the owner about a stalled case, with a link to it", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));

    await task()({ now: NOW.toISOString() });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`${userId}@example.com`);
    // A reminder that cannot be acted on is worse than none: it says the
    // case needs attention and leaves the person to find it.
    expect(sent[0]?.body).toContain(`${APP}/caso/${caseId}`);
  });

  it("mails about an expired deadline", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "deadline_expired", new Date(NOW.getTime() - 2 * DAY_MS));

    await task()({ now: NOW.toISOString() });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toMatch(/prazo/i);
  });

  it("says nothing to a case nothing has happened to", async () => {
    await insertCase();
    await task()({ now: NOW.toISOString() });
    expect(sent).toEqual([]);
  });

  it("leaves a closed case alone", async () => {
    const caseId = await insertCase({ closed: true });
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));

    await task()({ now: NOW.toISOString() });

    expect(sent).toEqual([]);
  });
});

describe("RF-185's suppression: someone who just looked is not gone", () => {
  it("sends nothing when the owner opened the case within the window", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));
    await insertEvent(caseId, "case_viewed", new Date(NOW.getTime() - 3 * HOUR_MS));

    await task()({ now: NOW.toISOString() });

    expect(sent).toEqual([]);
  });

  // The discriminator. Without it the test above would pass against a job
  // that never sends anything at all.
  it("sends once the last visit is older than the window", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 3 * DAY_MS));
    await insertEvent(
      caseId, "case_viewed", new Date(NOW.getTime() - (SUPPRESSION_WINDOW_HOURS + 1) * HOUR_MS),
    );

    await task()({ now: NOW.toISOString() });

    expect(sent).toHaveLength(1);
  });

  // Suppression must not consume the reminder. If it did, a person who
  // happened to glance at the case on the wrong day would never be
  // reminded about that stall at all.
  it("still owes the reminder tomorrow: suppressing writes no event", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));
    await insertEvent(caseId, "case_viewed", new Date(NOW.getTime() - 3 * HOUR_MS));

    await task()({ now: NOW.toISOString() });
    expect(await reminderEvents(caseId)).toHaveLength(0);

    // A day later, with no further visit.
    await task()({ now: new Date(NOW.getTime() + DAY_MS).toISOString() });
    expect(sent).toHaveLength(1);
  });

  it("is suppressed by any user action, not only by opening the case", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));
    await insertEvent(caseId, "protocol_entered", new Date(NOW.getTime() - 2 * HOUR_MS));

    await task()({ now: NOW.toISOString() });

    expect(sent).toEqual([]);
  });
});

describe("idempotency: the sweep runs on a clock", () => {
  it("does not send the same reminder twice", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));

    await task()({ now: NOW.toISOString() });
    await task()({ now: new Date(NOW.getTime() + DAY_MS).toISOString() });
    await task()({ now: new Date(NOW.getTime() + 2 * DAY_MS).toISOString() });

    expect(sent).toHaveLength(1);
    expect(await reminderEvents(caseId)).toHaveLength(1);
  });

  // A case can stall more than once. A reminder sent about the first stall
  // must not silence the second.
  it("reminds again when the same reason happens again", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 10 * DAY_MS));

    await task()({ now: NOW.toISOString() });
    expect(sent).toHaveLength(1);

    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() + DAY_MS));
    await task()({ now: new Date(NOW.getTime() + 2 * DAY_MS).toISOString() });

    expect(sent).toHaveLength(2);
  });

  it("records the reason and the channel, so E12 can add push without a new column", async () => {
    const caseId = await insertCase();
    await insertEvent(caseId, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));

    await task()({ now: NOW.toISOString() });

    const [row] = await reminderEvents(caseId);
    expect(row?.payload).toMatchObject({ reason: "stalled", channel: "email" });
    expect(row?.occurredAt.getTime()).toBe(NOW.getTime());
  });
});

describe("A8: a failure is visible and costs one case", () => {
  it("keeps going when one mailbox fails, and does not record that reminder as sent", async () => {
    const failing = await insertCase();
    const working = await insertCase();
    await insertEvent(failing, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));
    await insertEvent(working, "case_stalled", new Date(NOW.getTime() - 2 * DAY_MS));

    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    let first = true;
    const flaky: Mailer = {
      async send(message) {
        if (first) { first = false; throw new Error("mailbox unreachable"); }
        sent.push(message);
      },
    };

    await task({ mailer: flaky })({ now: NOW.toISOString() });
    const failures = reported.mock.calls.length;
    reported.mockRestore();

    expect(failures).toBe(1);
    expect(sent).toHaveLength(1);
    // The one that threw owes its reminder still.
    expect(await reminderEvents(failing)).toHaveLength(0);
    expect(await reminderEvents(working)).toHaveLength(1);
  });

  // Not "a user with no e-mail is skipped": the schema makes that state
  // unreachable, and a test for it would have been describing behaviour the
  // database already forbids. `users.email` is NOT NULL, and trying to
  // insert one without it is rejected outright — which is the real
  // guarantee, so that is what this asserts.
  it("cannot have an owner without an e-mail: the schema refuses it", async () => {
    await expect(
      ctx.db.insert(users).values({ id: newId("usr") } as never),
    ).rejects.toThrow(/email/i);
  });
});
