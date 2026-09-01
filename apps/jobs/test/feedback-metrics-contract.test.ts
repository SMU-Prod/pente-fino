import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { ensureAnonymousSession, withUser } from "@pentefino/db";
import { createRuleMetricsTask } from "../src/tasks/rule-metrics.js";

const { findings, invoices, issuers, ruleMetrics, rules } = schema;

/**
 * The seam between the feedback endpoint / the ingest pipeline and the
 * metrics job.
 *
 * `rule-metrics.ts` attributes a firing, dismissal or confirmation to a rule
 * by `ruleSlug` and `ruleVersion` in the event payload, and skips any event
 * missing either. The feedback route and the ingest pipeline
 * (`apps/jobs/src/tasks/ingest.ts`) are the only things that write those
 * events. Each side of the feedback/dismissal seam was built and tested on
 * its own and each was correct on its own; together they did not work,
 * because the route recorded no rule reference and the job silently dropped
 * every event it wrote.
 *
 * What that cost is worse than a lost statistic. With `dismissed` stuck at
 * zero, RF-126's promotion test — `dismissed / fired < 0,15` — is satisfied
 * by every rule forever, so a rule that a hundred people rejected promotes
 * out of shadow on its thirtieth firing exactly like one nobody objected
 * to. The automatic brake becomes an automatic accelerator, and shadow mode
 * stops being a filter and becomes a delay.
 *
 * `finding_created` is the same contract's third leg — RF-126/127's ratio has
 * no meaning at all if `fired` itself is silently zero — so this file tests
 * both the feedback route's side and the ingest pipeline's side against
 * `rule-metrics.ts`: write the event the way each producer actually writes
 * it, run the job the way the scheduler runs it, and assert the count
 * actually moved.
 */

const DAY = new Date("2026-08-31T00:00:00.000Z");
const DAY_ISO = "2026-08-31";
const RULE_SLUG = "contract-fixture-rule";
const RULE_VERSION = 1;

let ctx: TestDb;
let sessionId: string;
let invoiceId: string;
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

  invoiceId = await scoped.insertInvoice({
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

/**
 * Records `finding_created` exactly as `apps/jobs/src/tasks/ingest.ts` does:
 * `{ ruleSlug, ruleVersion }`, scoped to the invoice's own owner and stamped
 * on the invoice. Production writes this row through a system-scoped
 * `db.insert(events)` (INV-008's visible `eslint-disable`, not `withUser` —
 * there is no session inside a background job), but the row it produces has
 * the exact same shape `rule-metrics.ts` reads regardless of which path
 * wrote it, so `scoped.recordEvent` here is a faithful stand-in.
 */
async function recordFindingCreatedLikeIngest(payload: Record<string, unknown> = {
  ruleSlug: RULE_SLUG, ruleVersion: RULE_VERSION,
}) {
  const scoped = withUser({ sessionId }, ctx.db);
  await scoped.recordEvent("finding_created", payload, invoiceId);
  // recordEvent stamps occurredAt with now(); pin it to the day the job
  // aggregates so the assertion does not depend on the wall clock.
  await ctx.db.update(schema.events).set({ occurredAt: DAY }).where(eq(schema.events.invoiceId, invoiceId));
}

describe("ingest pipeline to rule-metrics contract (finding_created)", () => {
  it("counts a finding the ingest pipeline recorded", async () => {
    await recordFindingCreatedLikeIngest();
    await createRuleMetricsTask({ db: ctx.db })({ now: DAY.toISOString() });
    expect((await metricsRow())?.fired).toBe(1);
  });

  it("would leave fired at zero if the rule reference were dropped - the same failure mode this file " +
    "already covers for finding_dismissed, but for the leg RF-126/127's whole ratio depends on: a rule " +
    "that never registers a single `fired` can never even reach the 30/50-firing thresholds those checks " +
    "gate on, so a silently-empty ruleSlug/ruleVersion here is not a smaller signal, it is a rule that " +
    "never gets evaluated for promotion or pause at all", async () => {
    await recordFindingCreatedLikeIngest({});

    await createRuleMetricsTask({ db: ctx.db })({ now: DAY.toISOString() });

    const row = await metricsRow();
    expect(row?.fired ?? 0).toBe(0);
  });
});

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
