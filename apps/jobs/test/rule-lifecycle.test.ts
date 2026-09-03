import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { RuleSpec } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { applyRulePromotionProposal, createRuleLifecycleTask } from "../src/tasks/rule-lifecycle.js";

const { agentProposals, events, ruleMetrics, rules } = schema;

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

async function proposalsFor(kind: string) {
  return ctx.db.select().from(agentProposals).where(eq(agentProposals.kind, kind));
}

async function proposalRow(id: string) {
  const [row] = await ctx.db.select().from(agentProposals).where(eq(agentProposals.id, id));
  return row;
}

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
});

describe("rule-lifecycle task — promotion becomes a proposal, not an action (RF-126 + RF-304)", () => {
  it("writes a pending promote_rule proposal — and does NOT flip status — when dismissed/fired is below 0,15 over at least 30 firings", async () => {
    const id = await insertRule({ slug: "rn-promote", status: "shadow" });
    // 4/30 = 0.1333... < 0.15
    await insertMetrics("rn-promote", 1, "2026-08-01", 20, 3);
    await insertMetrics("rn-promote", 1, "2026-08-02", 10, 1);

    await task()({});

    // RF-304: taking a rule from shadow to active puts it in front of a real
    // user for the first time — that is the approval band, not the
    // automatic one. The rule itself must not move.
    const row = await ruleRow(id);
    expect(row?.status).toBe("shadow");

    const proposals = await proposalsFor("promote_rule");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe("pending");
    expect(proposals[0]?.target).toBe(id);
    expect(proposals[0]?.payload).toMatchObject({ ruleId: id, ruleSlug: "rn-promote", ruleVersion: 1 });
    expect(proposals[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fired=30"),
        expect.stringContaining("dismissed=4"),
        expect.stringContaining("ratio=4/30"),
      ]),
    );

    // No automatic status transition means no rule_promoted event either —
    // that event now only ever comes from applyRulePromotionProposal.
    expect(await eventsFor("rule_promoted")).toHaveLength(0);
    const created = await eventsFor("proposal_created");
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ kind: "promote_rule", ruleSlug: "rn-promote", fired: 30, dismissed: 4 });
  });

  it("does not propose promotion at 29 firings even with a perfect record — the boundary is 'at least 30', not 'more than 29 informally'", async () => {
    const id = await insertRule({ slug: "rn-29", status: "shadow" });
    await insertMetrics("rn-29", 1, "2026-08-01", 29, 0);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("shadow");
    expect(await proposalsFor("promote_rule")).toHaveLength(0);
    expect(await eventsFor("rule_promoted")).toHaveLength(0);
  });

  it("writes a pending proposal at exactly 30 firings with a qualifying ratio", async () => {
    const id = await insertRule({ slug: "rn-30", status: "shadow" });
    await insertMetrics("rn-30", 1, "2026-08-01", 30, 0);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("shadow");
    expect(await proposalsFor("promote_rule")).toHaveLength(1);
  });

  it("does not propose promotion for a rule sitting at exactly 0,15 — RF-126 requires strictly below the bar", async () => {
    const id = await insertRule({ slug: "rn-exact-15", status: "shadow" });
    // 6/40 = 0.15 exactly
    await insertMetrics("rn-exact-15", 1, "2026-08-01", 40, 6);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("shadow");
    expect(await proposalsFor("promote_rule")).toHaveLength(0);
    expect(await eventsFor("rule_promoted")).toHaveLength(0);
  });

  it("does not propose promotion for a shadow rule with 30+ firings but a dismiss ratio at or above 0,15", async () => {
    const id = await insertRule({ slug: "rn-bad-ratio", status: "shadow" });
    // 5/30 = 0.1666... >= 0.15
    await insertMetrics("rn-bad-ratio", 1, "2026-08-01", 30, 5);

    await task()({});

    expect((await ruleRow(id))?.status).toBe("shadow");
    expect(await proposalsFor("promote_rule")).toHaveLength(0);
  });

  it("leaves draft, active and paused rules untouched by the promotion pass", async () => {
    const draftId = await insertRule({ slug: "rn-draft", status: "draft" });
    await insertMetrics("rn-draft", 1, "2026-08-01", 100, 0);

    await task()({});

    expect((await ruleRow(draftId))?.status).toBe("draft");
    expect(await proposalsFor("promote_rule")).toHaveLength(0);
  });

  it("only proposes promotion for the version that actually earned it, leaving a sibling version's own status untouched", async () => {
    const v1 = await insertRule({ slug: "rn-versioned", version: 1, status: "shadow" });
    const v2 = await insertRule({ slug: "rn-versioned", version: 2, status: "shadow" });
    // v1 qualifies; v2 has too few firings.
    await insertMetrics("rn-versioned", 1, "2026-08-01", 30, 0);
    await insertMetrics("rn-versioned", 2, "2026-08-01", 5, 0);

    await task()({});

    expect((await ruleRow(v1))?.status).toBe("shadow");
    expect((await ruleRow(v2))?.status).toBe("shadow");

    const proposals = await proposalsFor("promote_rule");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.target).toBe(v1);
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
  it("running the pause pass twice in a row pauses once and does not double-record the event", async () => {
    const id = await insertRule({ slug: "rn-idempotent-pause", status: "active" });
    await insertMetrics("rn-idempotent-pause", 1, "2026-08-01", 50, 49);

    const run = task();
    await run({});
    await run({});

    expect((await ruleRow(id))?.status).toBe("paused");
    expect(await eventsFor("rule_paused")).toHaveLength(1);
  });

  it("running the promotion pass twice in a row writes only one pending proposal and does not double-record proposal_created", async () => {
    const id = await insertRule({ slug: "rn-idempotent", status: "shadow" });
    await insertMetrics("rn-idempotent", 1, "2026-08-01", 30, 0);

    const run = task();
    await run({});
    await run({});

    expect((await ruleRow(id))?.status).toBe("shadow");
    expect(await proposalsFor("promote_rule")).toHaveLength(1);
    expect(await eventsFor("proposal_created")).toHaveLength(1);
  });
});

describe("applyRulePromotionProposal — the only path that can flip a shadow rule to active (RF-304)", () => {
  it("approves a pending promote_rule proposal: flips the rule active, records rule_promoted, and stamps the decision", async () => {
    const ruleId = await insertRule({ slug: "rn-apply", status: "shadow" });
    await insertMetrics("rn-apply", 1, "2026-08-01", 30, 2);
    await task()({}); // writes the pending proposal

    const [proposal] = await proposalsFor("promote_rule");
    expect(proposal).toBeDefined();
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    await applyRulePromotionProposal(
      { db: ctx.db },
      { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "revisado manualmente, padrão consistente" },
    );

    expect((await ruleRow(ruleId))?.status).toBe("active");

    const decided = await proposalRow(proposal.id);
    expect(decided?.status).toBe("approved");
    expect(decided?.decidedBy).toBe("admin:erick");
    expect(decided?.decisionReason).toBe("revisado manualmente, padrão consistente");

    const promoted = await eventsFor("rule_promoted");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.payload).toMatchObject({ ruleSlug: "rn-apply", ruleVersion: 1, fired: 30, dismissed: 2 });

    expect(await eventsFor("proposal_decided")).toHaveLength(1);
  });

  it("reflects fresh totals at apply time, not a stale snapshot from when the proposal was written", async () => {
    const ruleId = await insertRule({ slug: "rn-fresh-totals", status: "shadow" });
    await insertMetrics("rn-fresh-totals", 1, "2026-08-01", 30, 0);
    await task()({});
    const [proposal] = await proposalsFor("promote_rule");
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    // More firings land while the proposal is awaiting a human decision.
    await insertMetrics("rn-fresh-totals", 1, "2026-08-02", 10, 1);

    await applyRulePromotionProposal(
      { db: ctx.db },
      { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "ok" },
    );

    const promoted = await eventsFor("rule_promoted");
    expect(promoted[0]?.payload).toMatchObject({ fired: 40, dismissed: 1 });
  });

  it("refuses to apply a proposal id that does not exist", async () => {
    await expect(
      applyRulePromotionProposal({ db: ctx.db }, { proposalId: "prp_missing", decidedBy: "x", decisionReason: "x" }),
    ).rejects.toThrow();
  });

  it("refuses to apply a proposal of a different kind", async () => {
    const id = newId("prp");
    await ctx.db.insert(agentProposals).values({ id, kind: "pause_rule", target: "x", payload: {}, evidence: ["x"] });

    await expect(
      applyRulePromotionProposal({ db: ctx.db }, { proposalId: id, decidedBy: "x", decisionReason: "x" }),
    ).rejects.toThrow();
  });

  it("refuses to re-apply a proposal that has already been decided", async () => {
    const ruleId = await insertRule({ slug: "rn-decided-twice", status: "shadow" });
    await insertMetrics("rn-decided-twice", 1, "2026-08-01", 30, 0);
    await task()({});
    const [proposal] = await proposalsFor("promote_rule");
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    await applyRulePromotionProposal(
      { db: ctx.db },
      { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "ok" },
    );

    await expect(
      applyRulePromotionProposal(
        { db: ctx.db },
        { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "ok de novo" },
      ),
    ).rejects.toThrow();

    // The first decision is not clobbered by the rejected second attempt.
    expect((await ruleRow(ruleId))?.status).toBe("active");
    expect((await proposalRow(proposal.id))?.decisionReason).toBe("ok");
  });

  it("refuses to apply a proposal whose target rule is no longer shadow", async () => {
    const ruleId = await insertRule({ slug: "rn-moved-on", status: "shadow" });
    await insertMetrics("rn-moved-on", 1, "2026-08-01", 30, 0);
    await task()({});
    const [proposal] = await proposalsFor("promote_rule");
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    // Someone edited the rule directly (RF-301 CRUD) since the proposal was written.
    await ctx.db.update(rules).set({ status: "paused" }).where(eq(rules.id, ruleId));

    await expect(
      applyRulePromotionProposal({ db: ctx.db }, { proposalId: proposal.id, decidedBy: "x", decisionReason: "x" }),
    ).rejects.toThrow();
  });
});

describe("applyRulePromotionProposal — retiring a superseded version (RF-301 double-firing close)", () => {
  it("pauses the same slug's other active version and records rule_version_superseded", async () => {
    const v1 = await insertRule({ slug: "rn-supersede", version: 1, status: "active" });
    const v2 = await insertRule({ slug: "rn-supersede", version: 2, status: "shadow" });
    await insertMetrics("rn-supersede", 2, "2026-08-01", 30, 0);
    await task()({}); // writes the pending proposal for v2

    const [proposal] = await proposalsFor("promote_rule");
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    await applyRulePromotionProposal(
      { db: ctx.db },
      { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "v2 supera v1" },
    );

    expect((await ruleRow(v2))?.status).toBe("active");
    expect((await ruleRow(v1))?.status).toBe("paused");

    const superseded = await eventsFor("rule_version_superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.payload).toMatchObject({
      ruleId: v1,
      ruleSlug: "rn-supersede",
      supersededVersion: 1,
      bySupersedingVersion: 2,
      proposalId: proposal.id,
    });
  });

  it("leaves a predecessor that is already paused untouched, and writes no superseded event for it", async () => {
    const v1 = await insertRule({ slug: "rn-supersede-paused", version: 1, status: "paused" });
    const v2 = await insertRule({ slug: "rn-supersede-paused", version: 2, status: "shadow" });
    await insertMetrics("rn-supersede-paused", 2, "2026-08-01", 30, 0);
    await task()({});

    const [proposal] = await proposalsFor("promote_rule");
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    await applyRulePromotionProposal(
      { db: ctx.db },
      { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "ok" },
    );

    expect((await ruleRow(v2))?.status).toBe("active");
    expect((await ruleRow(v1))?.status).toBe("paused");
    expect(await eventsFor("rule_version_superseded")).toHaveLength(0);
  });

  it("promotes a rule with only one version with no superseded event — proves the new code does not fire spuriously", async () => {
    const ruleId = await insertRule({ slug: "rn-only-version", status: "shadow" });
    await insertMetrics("rn-only-version", 1, "2026-08-01", 30, 0);
    await task()({});

    const [proposal] = await proposalsFor("promote_rule");
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    await applyRulePromotionProposal(
      { db: ctx.db },
      { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "ok" },
    );

    expect((await ruleRow(ruleId))?.status).toBe("active");
    expect(await eventsFor("rule_version_superseded")).toHaveLength(0);
  });

  it("leaves an unrelated slug's active rule untouched — retirement is keyed on slug, not on every active rule", async () => {
    const unrelatedId = await insertRule({ slug: "rn-unrelated", status: "active" });

    const v1 = await insertRule({ slug: "rn-keyed", version: 1, status: "active" });
    const v2 = await insertRule({ slug: "rn-keyed", version: 2, status: "shadow" });
    await insertMetrics("rn-keyed", 2, "2026-08-01", 30, 0);
    await task()({});

    const [proposal] = await proposalsFor("promote_rule");
    if (!proposal) throw new Error("expected a pending promote_rule proposal");

    await applyRulePromotionProposal(
      { db: ctx.db },
      { proposalId: proposal.id, decidedBy: "admin:erick", decisionReason: "ok" },
    );

    expect((await ruleRow(v1))?.status).toBe("paused");
    expect((await ruleRow(unrelatedId))?.status).toBe("active");

    const superseded = await eventsFor("rule_version_superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.payload).toMatchObject({ ruleId: v1, ruleSlug: "rn-keyed" });
  });
});
