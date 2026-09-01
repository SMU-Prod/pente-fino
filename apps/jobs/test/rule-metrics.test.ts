import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createRuleMetricsTask } from "../src/tasks/rule-metrics.js";

const { events, ruleMetrics } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed reference instant, never the real wall clock (per the brief).
const DAY = new Date("2026-08-31T00:00:00.000Z");
const DAY_ISO = "2026-08-31";

let ctx: TestDb;

function task() {
  return createRuleMetricsTask({ db: ctx.db });
}

async function insertEvent(
  type: "finding_created" | "finding_dismissed" | "finding_confirmed" | "report_viewed",
  payload: Record<string, unknown>,
  occurredAt: Date,
) {
  await ctx.db.insert(events).values({ id: newId("evt"), type, payload, occurredAt });
}

async function metricsRow(ruleSlug: string, ruleVersion: number) {
  const [row] = await ctx.db
    .select()
    .from(ruleMetrics)
    .where(and(eq(ruleMetrics.ruleSlug, ruleSlug), eq(ruleMetrics.ruleVersion, ruleVersion), eq(ruleMetrics.day, DAY_ISO)));
  return row;
}

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
});

describe("rule-metrics task (RF-302)", () => {
  it("counts fired, dismissed and confirmed events into a rule_metrics row keyed by rule and day", async () => {
    const mid = new Date(DAY.getTime() + 6 * 60 * 60 * 1000); // same day, different hour

    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, DAY);
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, mid);
    await insertEvent("finding_dismissed", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, mid);
    await insertEvent("finding_confirmed", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, mid);

    // A second rule, to prove counts are not pooled across rules.
    await insertEvent("finding_created", { ruleSlug: "rn-002", ruleVersion: 1, findingId: newId("fnd") }, DAY);

    await task()({ now: DAY.toISOString() });

    const rn001 = await metricsRow("rn-001", 1);
    expect(rn001).toMatchObject({ fired: 2, dismissed: 1, confirmed: 1, contested: 0, resolved: 0 });

    const rn002 = await metricsRow("rn-002", 1);
    expect(rn002).toMatchObject({ fired: 1, dismissed: 0, confirmed: 0 });
  });

  it("keeps two versions of the same slug as separate rows (RF-301: a version is a separate unit of evidence)", async () => {
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, DAY);
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 2, findingId: newId("fnd") }, DAY);
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 2, findingId: newId("fnd") }, DAY);

    await task()({ now: DAY.toISOString() });

    expect((await metricsRow("rn-001", 1))?.fired).toBe(1);
    expect((await metricsRow("rn-001", 2))?.fired).toBe(2);
  });

  it("ignores events outside the target day, in both directions", async () => {
    const beforeDay = new Date(DAY.getTime() - 1);
    const afterDay = new Date(DAY.getTime() + DAY_MS);

    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, beforeDay);
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, afterDay);

    await task()({ now: DAY.toISOString() });

    expect(await metricsRow("rn-001", 1)).toBeUndefined();
  });

  it("ignores event types that are not finding outcomes", async () => {
    await insertEvent("report_viewed", { ruleSlug: "rn-001", ruleVersion: 1 }, DAY);

    await task()({ now: DAY.toISOString() });

    expect(await metricsRow("rn-001", 1)).toBeUndefined();
  });

  it("skips an event whose payload carries no rule reference instead of throwing", async () => {
    await insertEvent("finding_created", { findingId: newId("fnd") }, DAY);
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, DAY);

    await expect(task()({ now: DAY.toISOString() })).resolves.toBeUndefined();

    expect((await metricsRow("rn-001", 1))?.fired).toBe(1);
  });

  it("recomputing the same day produces an identical result (RF-302)", async () => {
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, DAY);
    await insertEvent("finding_created", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, DAY);
    await insertEvent("finding_dismissed", { ruleSlug: "rn-001", ruleVersion: 1, findingId: newId("fnd") }, DAY);

    const run = task();
    await run({ now: DAY.toISOString() });
    const first = await metricsRow("rn-001", 1);

    await run({ now: DAY.toISOString() });
    const second = await metricsRow("rn-001", 1);

    expect(second?.id).toBe(first?.id); // same row, updated in place — not a duplicate insert
    expect(second).toMatchObject({ fired: first?.fired, dismissed: first?.dismissed, confirmed: first?.confirmed });
    expect(second).toMatchObject({ fired: 2, dismissed: 1, confirmed: 0 });

    const allRows = await ctx.db.select().from(ruleMetrics);
    expect(allRows.filter((r) => r.ruleSlug === "rn-001" && r.ruleVersion === 1)).toHaveLength(1);
  });

  it("recomputing a day with no matching events yet leaves no row rather than fabricating a zero row", async () => {
    await task()({ now: DAY.toISOString() });
    expect(await metricsRow("rn-001", 1)).toBeUndefined();
  });
});
