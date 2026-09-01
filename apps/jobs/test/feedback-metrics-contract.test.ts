import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { ensureAnonymousSession, withUser } from "@pentefino/db";
import { createRuleMetricsTask } from "../src/tasks/rule-metrics.js";

const { findings, invoices, issuers, ruleMetrics, rules } = schema;

/**
 * The seam between the feedback endpoint and the metrics job.
 *
 * `rule-metrics.ts` attributes a dismissal to a rule by `ruleSlug` and
 * `ruleVersion` in the event payload, and skips any event missing either.
 * The feedback route is the only thing that writes those events. Each side
 * was built and tested on its own and each was correct on its own; together
 * they did not work, because the route recorded no rule reference and the
 * job silently dropped every event it wrote.
 *
 * What that cost is worse than a lost statistic. With `dismissed` stuck at
 * zero, RF-126's promotion test — `dismissed / fired < 0,15` — is satisfied
 * by every rule forever, so a rule that a hundred people rejected promotes
 * out of shadow on its thirtieth firing exactly like one nobody objected
 * to. The automatic brake becomes an automatic accelerator, and shadow mode
 * stops being a filter and becomes a delay.
 *
 * So this file tests the two sides against each other rather than each
 * alone: write feedback the way the route writes it, run the job the way
 * the scheduler runs it, and assert the count actually moved.
 */

const DAY = new Date("2026-08-31T00:00:00.000Z");
const DAY_ISO = "2026-08-31";
const RULE_SLUG = "contract-fixture-rule";
const RULE_VERSION = 1;

let ctx: TestDb;
let sessionId: string;
let findingId: string;

beforeEach(async () => {
  ctx = await createTestDb();
  sessionId = newId("ses");
  await ensureAnonymousSession(sessionId, new Date("2026-09-30T00:00:00.000Z"), ctx.db);

  const scoped = withUser({ sessionId }, ctx.db);
  const [issuer] = await ctx.db
    .select({ id: issuers.id })
    .from(issuers)
    .where(eq(issuers.slug, "claro-movel"));
  if (!issuer) throw new Error("expected createTestDb to seed the claro-movel issuer");

  const invoiceId = await scoped.insertInvoice({
    contentHash: "contract-hash", source: "pdf_text", issuerId: issuer.id,
  });

  const ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId,
    slug: RULE_SLUG,
    version: RULE_VERSION,
    category: "telecom",
    kind: "pattern",
    spec: { kind: "pattern", match: "SVA" },
    legalBasis: [{ law: "CDC", article: "art. 39, III, p.u.", effect: "vedada" }],
    confidenceBase: 0.8,
    status: "shadow",
    author: "test",
    reason: "contract fixture",
  });

  findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId,
    invoiceId,
    ruleId,
    ruleVersion: RULE_VERSION,
    confidence: 0.8,
    evidence: ["Linha em seção de serviços digitais"],
    amountCents: 990,
    shadow: false,
  });
});

afterEach(async () => {
  await ctx.close();
});

async function metricsRow() {
  const [row] = await ctx.db
    .select()
    .from(ruleMetrics)
    .where(and(
      eq(ruleMetrics.ruleSlug, RULE_SLUG),
      eq(ruleMetrics.ruleVersion, RULE_VERSION),
      eq(ruleMetrics.day, DAY_ISO),
    ));
  return row;
}

/** Records feedback exactly as `POST /api/findings/:id/feedback` does. */
async function recordFeedbackLikeTheRoute(action: "dismiss" | "confirm") {
  const scoped = withUser({ sessionId }, ctx.db);
  const owned = await scoped.setFindingFeedback(
    findingId,
    action === "dismiss" ? "dismissed_by_user" : "confirmed_by_user",
  );
  if (!owned) throw new Error("expected the session to own the finding");
  await scoped.recordEvent(
    action === "dismiss" ? "finding_dismissed" : "finding_confirmed",
    { ruleSlug: owned.ruleSlug, ruleVersion: owned.ruleVersion },
    owned.invoiceId,
  );
  // recordEvent stamps occurredAt with now(); pin it to the day the job
  // aggregates so the assertion does not depend on the wall clock.
  await ctx.db.update(schema.events).set({ occurredAt: DAY }).where(eq(schema.events.invoiceId, owned.invoiceId));
}

describe("feedback endpoint to rule-metrics contract", () => {
  it("carries the rule reference the metrics job needs", async () => {
    const scoped = withUser({ sessionId }, ctx.db);
    const owned = await scoped.setFindingFeedback(findingId, "dismissed_by_user");
    expect(owned?.ruleSlug).toBe(RULE_SLUG);
    expect(owned?.ruleVersion).toBe(RULE_VERSION);
  });

  it("counts a dismissal the route recorded", async () => {
    await recordFeedbackLikeTheRoute("dismiss");
    await createRuleMetricsTask({ db: ctx.db })({ now: DAY.toISOString() });
    expect((await metricsRow())?.dismissed).toBe(1);
  });

  it("counts a confirmation the route recorded", async () => {
    await recordFeedbackLikeTheRoute("confirm");
    await createRuleMetricsTask({ db: ctx.db })({ now: DAY.toISOString() });
    expect((await metricsRow())?.confirmed).toBe(1);
  });

  it("would leave dismissed at zero if the rule reference were dropped", async () => {
    // The exact defect this file exists for: the payload the route used to
    // record. If a future change stops carrying the rule reference, the job
    // does not fail — it silently counts nothing, which is why this asserts
    // the broken shape's outcome rather than only the fixed one's.
    const scoped = withUser({ sessionId }, ctx.db);
    const owned = await scoped.setFindingFeedback(findingId, "dismissed_by_user");
    await scoped.recordEvent("finding_dismissed", {}, owned?.invoiceId);
    await ctx.db.update(schema.events).set({ occurredAt: DAY }).where(eq(schema.events.invoiceId, owned!.invoiceId));

    await createRuleMetricsTask({ db: ctx.db })({ now: DAY.toISOString() });

    const row = await metricsRow();
    expect(row?.dismissed ?? 0).toBe(0);
  });
});
