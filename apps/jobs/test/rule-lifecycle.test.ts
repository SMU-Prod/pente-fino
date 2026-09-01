import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { RuleSpec } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createRuleLifecycleTask } from "../src/tasks/rule-lifecycle.js";

const { events, ruleMetrics, rules } = schema;

let ctx: TestDb;

function task() {
  return createRuleLifecycleTask({ db: ctx.db });
}

const SPEC: RuleSpec = { kind: "pattern", match: "TESTE" };

async function insertRule(overrides: { slug: string; version?: number; status: "draft" | "shadow" | "active" | "paused" }) {
  const id = newId("rul");
  await ctx.db.insert(rules).values({
    id,
    slug: overrides.slug,
    version: overrides.version ?? 1,
    category: "telecom",
    issuerId: null,
    kind: "pattern",
    spec: SPEC,
    legalBasis: [{ law: "CDC", article: "art. 39", effect: "vedada" }],
    confidenceBase: 0.9,
    status: overrides.status,
    shadowUntil: overrides.status === "shadow" ? new Date("2026-09-07T00:00:00.000Z") : null,
    author: "test",
    reason: "fixture rule for RF-126/RF-127",
  });
  return id;
}

// Inserts one rule_metrics row per call; tests spread `fired`/`dismissed`
// across a couple of days to prove the lifecycle job sums across days
// rather than reading a single day.
async function insertMetrics(ruleSlug: string, ruleVersion: number, day: string, fired: number, dismissed: number) {
  await ctx.db.insert(ruleMetrics).values({
    id: newId("rmt"), ruleSlug, ruleVersion, day, fired, dismissed, confirmed: 0, contested: 0, resolved: 0,
  });
}

async function ruleRow(id: string) {
  const [row] = await ctx.db.select().from(rules).where(eq(rules.id, id));
  return row;
}

async function eventsFor(type: string) {
  return ctx.db.select().from(events).where(eq(events.type, type));
}

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
});

describe("rule-lifecycle task — promotion (RF-126)", () => {
  it("promotes a shadow rule to active when dismissed/fired is below 0,15 over at least 30 firings", async () => {
    const id = await insertRule({ slug: "rn-promote", status: "shadow" });
    // 4/30 = 0.1333... < 0.15
    await insertMetrics("rn-promote", 1, "2026-08-01", 20, 3);
    await insertMetrics("rn-promote", 1, "2026-08-02", 10, 1);

    await task()({});

    const row = await ruleRow(id);
    expect(row?.status).toBe("active");

    const promoted = await eventsFor("rule_promoted");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.payload).toMatchObject({ ruleSlug: "rn-promote", ruleVersion: 1, fired: 30, dismissed: 4 });
  });

  it("does not promote at 29 firings even with a perfect record — the boundary is 'at least 30', not 'more than 29 informally'", async () => {
    const id = await insertRule({ slug: "rn-29", status: "shadow" });
    await insertMetrics("rn-29", 1, "2026-08-01", 29, 0);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("shadow");
    expect(await eventsFor("rule_promoted")).toHaveLength(0);
  });

  it("promotes at exactly 30 firings with a qualifying ratio", async () => {
    const id = await insertRule({ slug: "rn-30", status: "shadow" });
    await insertMetrics("rn-30", 1, "2026-08-01", 30, 0);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("active");
  });

  it("does not promote a rule sitting at exactly 0,15 — RF-126 requires strictly below the bar", async () => {
    const id = await insertRule({ slug: "rn-exact-15", status: "shadow" });
    // 6/40 = 0.15 exactly
    await insertMetrics("rn-exact-15", 1, "2026-08-01", 40, 6);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("shadow");
    expect(await eventsFor("rule_promoted")).toHaveLength(0);
  });

  it("does not promote a shadow rule with 30+ firings but a dismiss ratio at or above 0,15", async () => {
    const id = await insertRule({ slug: "rn-bad-ratio", status: "shadow" });
    // 5/30 = 0.1666... >= 0.15
    await insertMetrics("rn-bad-ratio", 1, "2026-08-01", 30, 5);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("shadow");
  });

  it("leaves draft, active and paused rules untouched by the promotion pass", async () => {
    const draftId = await insertRule({ slug: "rn-draft", status: "draft" });
    await insertMetrics("rn-draft", 1, "2026-08-01", 100, 0);

    await task()({});

    expect((await ruleRow(draftId))?.status).toBe("draft");
  });

  it("only promotes the version that actually earned it, leaving a sibling version's own status untouched", async () => {
    const v1 = await insertRule({ slug: "rn-versioned", version: 1, status: "shadow" });
    const v2 = await insertRule({ slug: "rn-versioned", version: 2, status: "shadow" });
    // v1 qualifies; v2 has too few firings.
    await insertMetrics("rn-versioned", 1, "2026-08-01", 30, 0);
    await insertMetrics("rn-versioned", 2, "2026-08-01", 5, 0);

    await task()({});

    expect((await ruleRow(v1))?.status).toBe("active");
    expect((await ruleRow(v2))?.status).toBe("shadow");
  });
});

describe("rule-lifecycle task — automatic pause (RF-127)", () => {
  it("pauses an active rule when dismissed/fired is above 0,15 over 50+ firings, and raises an alert", async () => {
    const id = await insertRule({ slug: "rn-pause", status: "active" });
    // 9/50 = 0.18 > 0.15
    await insertMetrics("rn-pause", 1, "2026-08-01", 30, 5);
    await insertMetrics("rn-pause", 1, "2026-08-02", 20, 4);

    await task()({});

    const row = await ruleRow(id);
    expect(row?.status).toBe("paused");

    const paused = await eventsFor("rule_paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]?.payload).toMatchObject({ ruleSlug: "rn-pause", ruleVersion: 1, fired: 50, dismissed: 9 });
  });

  it("does not pause at 49 firings even with a terrible ratio — the boundary is '50+', not '49 is close enough'", async () => {
    const id = await insertRule({ slug: "rn-49", status: "active" });
    await insertMetrics("rn-49", 1, "2026-08-01", 49, 49);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("active");
    expect(await eventsFor("rule_paused")).toHaveLength(0);
  });

  it("pauses at exactly 50 firings with a disqualifying ratio", async () => {
    const id = await insertRule({ slug: "rn-50", status: "active" });
    await insertMetrics("rn-50", 1, "2026-08-01", 50, 49);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("paused");
  });

  it("does not pause a rule sitting at exactly 0,15 — RF-127 requires strictly above the bar", async () => {
    const id = await insertRule({ slug: "rn-exact-15-active", status: "active" });
    // 9/60 = 0.15 exactly
    await insertMetrics("rn-exact-15-active", 1, "2026-08-01", 60, 9);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("active");
    expect(await eventsFor("rule_paused")).toHaveLength(0);
  });

  it("does not pause an active rule with 50+ firings whose dismiss ratio is at or below 0,15", async () => {
    const id = await insertRule({ slug: "rn-good-ratio", status: "active" });
    // 5/60 = 0.0833...
    await insertMetrics("rn-good-ratio", 1, "2026-08-01", 60, 5);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("active");
  });

  it("leaves an already-paused rule alone rather than re-processing it", async () => {
    const id = await insertRule({ slug: "rn-already-paused", status: "paused" });
    await insertMetrics("rn-already-paused", 1, "2026-08-01", 100, 90);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("paused");
    expect(await eventsFor("rule_paused")).toHaveLength(0);
  });
});

describe("rule-lifecycle task — RF-301 (versioned rows, never mutated destructively)", () => {
  it("promotion updates only status, leaving slug, version and spec exactly as seeded", async () => {
    const id = await insertRule({ slug: "rn-untouched-content", status: "shadow" });
    await insertMetrics("rn-untouched-content", 1, "2026-08-01", 30, 0);

    await task()({});

    const row = await ruleRow(id);
    expect(row?.slug).toBe("rn-untouched-content");
    expect(row?.version).toBe(1);
    expect(row?.spec).toEqual(SPEC);
  });
});

describe("rule-lifecycle task — idempotency", () => {
  it("running twice in a row promotes once and does not double-record the event", async () => {
    const id = await insertRule({ slug: "rn-idempotent", status: "shadow" });
    await insertMetrics("rn-idempotent", 1, "2026-08-01", 30, 0);

    const run = task();
    await run({});
    await run({});

    expect((await ruleRow(id))?.status).toBe("active");
    expect(await eventsFor("rule_promoted")).toHaveLength(1);
  });
});
