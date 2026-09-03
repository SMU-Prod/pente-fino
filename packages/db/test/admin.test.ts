import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newId, type RuleDraftInput } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { agentProposals, aiCalls, cases, events, findings, invoices, issuers, ruleMetrics, rules, seoPages, users } from "../src/schema.js";
import {
  RuleDraftError,
  activateRuleVersion,
  adminAccount,
  adminOverview,
  createRuleVersion,
  listProposals,
  listRuleFamilies,
  pauseRuleVersion,
  rejectProposal,
} from "../src/admin.js";

const VALID_DRAFT: RuleDraftInput = {
  slug: "gasto-recorrente-teste",
  category: "telecom",
  issuerId: null,
  kind: "pattern",
  spec: { kind: "pattern", match: "SVA|SEGURO" },
  legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
  confidenceBase: 0.7,
  author: "admin-teste",
  reason: "Regra de teste para validação do formulário.",
};

const VALID_SUPPRESSOR_DRAFT: RuleDraftInput = {
  slug: "supressor-teste",
  category: "energy",
  issuerId: null,
  kind: "suppressor",
  spec: {
    kind: "suppressor",
    blocks: ["(?=.*\\bICMS\\b)(?=.*\\bTUSD\\b)"],
    reason: "Tese morta (Tema 986/STJ).",
  },
  legalBasis: [],
  confidenceBase: 1,
  author: "admin-teste",
  reason: "RN-090: suprime tese morta sobre ICMS na TUSD.",
};

type RuleOverrides = Partial<typeof rules.$inferInsert> & { slug: string };

/** A minimal `rules` row at whatever status a refusal test needs — inserted directly, bypassing `createRuleVersion`. */
async function insertRuleRow(db: TestDb["db"], overrides: RuleOverrides): Promise<typeof rules.$inferSelect> {
  const id = overrides.id ?? newId("rul");
  await db.insert(rules).values({
    id,
    slug: overrides.slug,
    version: overrides.version ?? 1,
    category: overrides.category ?? "telecom",
    issuerId: overrides.issuerId ?? null,
    kind: overrides.kind ?? "pattern",
    spec: overrides.spec ?? { kind: "pattern", match: "TESTE" },
    legalBasis: overrides.legalBasis ?? [],
    confidenceBase: overrides.confidenceBase ?? 0.8,
    status: overrides.status ?? "draft",
    shadowUntil: overrides.shadowUntil ?? null,
    author: overrides.author ?? "system",
    reason: overrides.reason ?? "fixture",
  });
  const [row] = await db.select().from(rules).where(eq(rules.id, id));
  if (!row) throw new Error("insertRuleRow: insert failed");
  return row;
}

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

describe("adminAccount", () => {
  it("returns null when there is no user with that id", async () => {
    expect(await adminAccount(ctx.db, newId("usr"))).toBeNull();
  });

  it("returns id and email for an active user", async () => {
    const id = newId("usr");
    await ctx.db.insert(users).values({ id, email: "admin@example.com" });
    expect(await adminAccount(ctx.db, id)).toEqual({ id, email: "admin@example.com" });
  });

  it("returns null when the user's deletedAt is set", async () => {
    const id = newId("usr");
    await ctx.db.insert(users).values({ id, email: "removido@example.com", deletedAt: new Date() });
    expect(await adminAccount(ctx.db, id)).toBeNull();
  });
});

describe("createRuleVersion", () => {
  it("gives version 1, status draft, shadowUntil null for a brand-new slug", async () => {
    const result = await createRuleVersion(ctx.db, VALID_DRAFT);
    expect(result.version).toBe(1);
    expect(result.slug).toBe(VALID_DRAFT.slug);

    const [row] = await ctx.db.select().from(rules).where(eq(rules.id, result.id));
    expect(row?.status).toBe("draft");
    expect(row?.shadowUntil).toBeNull();
  });

  it("gives max+1 for an existing slug and leaves the predecessor row byte-identical", async () => {
    const first = await createRuleVersion(ctx.db, VALID_DRAFT);
    const [before] = await ctx.db.select().from(rules).where(eq(rules.id, first.id));

    const second = await createRuleVersion(ctx.db, { ...VALID_DRAFT, reason: "Segunda versão, motivo diferente." });
    expect(second.version).toBe(2);
    expect(second.slug).toBe(VALID_DRAFT.slug);
    expect(second.id).not.toBe(first.id);

    const [after] = await ctx.db.select().from(rules).where(eq(rules.id, first.id));
    expect(after).toEqual(before);
  });

  it("writes a rule_version_created event carrying ruleId, ruleSlug, ruleVersion, previousVersion and author", async () => {
    const first = await createRuleVersion(ctx.db, VALID_DRAFT);
    const second = await createRuleVersion(ctx.db, { ...VALID_DRAFT, reason: "Outra versão." });

    const rows = await ctx.db.select().from(events).where(eq(events.type, "rule_version_created"));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload).toMatchObject({
      ruleId: first.id, ruleSlug: VALID_DRAFT.slug, ruleVersion: 1, previousVersion: null, author: VALID_DRAFT.author,
    });
    expect(rows[1]?.payload).toMatchObject({
      ruleId: second.id, ruleSlug: VALID_DRAFT.slug, ruleVersion: 2, previousVersion: 1, author: VALID_DRAFT.author,
    });
  });

  it("rejects an unsafe pattern, wrapped in RuleDraftError, and writes nothing", async () => {
    await expect(
      createRuleVersion(ctx.db, { ...VALID_DRAFT, spec: { kind: "pattern", match: "(a+)+" } }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ field: "spec.match", code: "unsafe_pattern" })]),
    });

    // `createTestDb()` seeds a real rule catalog (deterministic + suppressor +
    // lexicon rules, per `seedAll`), so the table is never empty — the
    // assertion is that *this test's own slug* wrote nothing, not that the
    // whole table is empty.
    expect(await ctx.db.select().from(rules).where(eq(rules.slug, VALID_DRAFT.slug))).toHaveLength(0);
  });

  it("rejects a sensitive-category term, wrapped in RuleDraftError, and writes nothing", async () => {
    await expect(
      createRuleVersion(ctx.db, { ...VALID_DRAFT, spec: { kind: "pattern", match: "farmacia|drogaria" } }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ code: "sensitive_term" })]),
    });

    expect(await ctx.db.select().from(rules).where(eq(rules.slug, VALID_DRAFT.slug))).toHaveLength(0);
  });

  it("rejects re-typing a suppressor into a pattern rule on its next version (INV-010)", async () => {
    await createRuleVersion(ctx.db, VALID_SUPPRESSOR_DRAFT);

    await expect(
      createRuleVersion(ctx.db, {
        ...VALID_SUPPRESSOR_DRAFT,
        kind: "pattern",
        spec: { kind: "pattern", match: "ICMS" },
        legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
      }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ field: "kind", code: "suppressor_kind_locked" })]),
    });

    const rows = await ctx.db.select().from(rules).where(eq(rules.slug, VALID_SUPPRESSOR_DRAFT.slug));
    expect(rows).toHaveLength(1);
  });

  it("allows a second suppressor version under the same slug", async () => {
    await createRuleVersion(ctx.db, VALID_SUPPRESSOR_DRAFT);
    const second = await createRuleVersion(ctx.db, { ...VALID_SUPPRESSOR_DRAFT, reason: "Segunda redação do supressor." });
    expect(second.version).toBe(2);
  });
});

describe("activateRuleVersion", () => {
  it("moves draft to shadow with a 7-day shadowUntil, and writes rule_version_activated", async () => {
    const created = await createRuleVersion(ctx.db, VALID_DRAFT);
    const now = new Date("2026-09-03T12:00:00.000Z");

    await activateRuleVersion(ctx.db, { ruleId: created.id, actor: "admin-teste", now });

    const [row] = await ctx.db.select().from(rules).where(eq(rules.id, created.id));
    expect(row?.status).toBe("shadow");
    expect(row?.shadowUntil?.getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [evt] = await ctx.db.select().from(events).where(eq(events.type, "rule_version_activated"));
    expect(evt?.payload).toMatchObject({
      ruleId: created.id, ruleSlug: VALID_DRAFT.slug, ruleVersion: 1, actor: "admin-teste",
    });
  });

  it("refuses a rule that is already shadow", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-ativa-shadow", status: "shadow", shadowUntil: new Date() });
    await expect(activateRuleVersion(ctx.db, { ruleId: rule.id, actor: "admin-teste" })).rejects.toThrow(/"shadow"/);
  });

  it("refuses a rule that is already active", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-ativa-active", status: "active" });
    await expect(activateRuleVersion(ctx.db, { ruleId: rule.id, actor: "admin-teste" })).rejects.toThrow(/"active"/);
  });
});

describe("pauseRuleVersion", () => {
  it("pauses an active rule and writes rule_paused carrying decidedBy", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-pausa-humana", status: "active" });
    await pauseRuleVersion(ctx.db, { ruleId: rule.id, actor: "admin-teste", reason: "Falso positivo recorrente." });

    const [row] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(row?.status).toBe("paused");

    const [evt] = await ctx.db.select().from(events).where(eq(events.type, "rule_paused"));
    expect(evt?.payload).toMatchObject({
      ruleId: rule.id, ruleSlug: rule.slug, ruleVersion: rule.version,
      decidedBy: "admin-teste", decisionReason: "Falso positivo recorrente.",
    });
  });

  it("pauses a shadow rule too", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-pausa-shadow", status: "shadow", shadowUntil: new Date() });
    await pauseRuleVersion(ctx.db, { ruleId: rule.id, actor: "admin-teste", reason: "Ratio ruim." });
    const [row] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(row?.status).toBe("paused");
  });

  it("refuses a draft rule", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-pausa-draft", status: "draft" });
    await expect(
      pauseRuleVersion(ctx.db, { ruleId: rule.id, actor: "admin-teste", reason: "x" }),
    ).rejects.toThrow(/"draft"/);
  });

  it("refuses an already-paused rule", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-pausa-dupla", status: "paused" });
    await expect(
      pauseRuleVersion(ctx.db, { ruleId: rule.id, actor: "admin-teste", reason: "x" }),
    ).rejects.toThrow(/"paused"/);
  });
});

describe("listRuleFamilies", () => {
  it("sums rule_metrics across multiple day rows and does not mix two versions' metrics", async () => {
    await insertRuleRow(ctx.db, { slug: "rn-familia", version: 1, status: "shadow", shadowUntil: new Date() });
    await insertRuleRow(ctx.db, { slug: "rn-familia", version: 2, status: "draft" });

    await ctx.db.insert(ruleMetrics).values([
      { id: newId("rmt"), ruleSlug: "rn-familia", ruleVersion: 1, day: "2026-08-01", fired: 10, dismissed: 1, confirmed: 2, contested: 0, resolved: 0 },
      { id: newId("rmt"), ruleSlug: "rn-familia", ruleVersion: 1, day: "2026-08-02", fired: 20, dismissed: 2, confirmed: 3, contested: 1, resolved: 1 },
      { id: newId("rmt"), ruleSlug: "rn-familia", ruleVersion: 2, day: "2026-08-02", fired: 5, dismissed: 0, confirmed: 0, contested: 0, resolved: 0 },
    ]);

    const families = await listRuleFamilies(ctx.db);
    const family = families.find((f) => f.slug === "rn-familia");
    expect(family?.versions.map((v) => v.version)).toEqual([2, 1]);

    expect(family?.versions.find((v) => v.version === 1)?.metrics).toEqual({
      fired: 30, dismissed: 3, confirmed: 5, contested: 1, resolved: 1,
    });
    expect(family?.versions.find((v) => v.version === 2)?.metrics).toEqual({
      fired: 5, dismissed: 0, confirmed: 0, contested: 0, resolved: 0,
    });
  });

  it("reports no pending promotion proposal when none exists, and true when one does", async () => {
    const withoutProposal = await insertRuleRow(ctx.db, { slug: "rn-sem-proposta", status: "shadow", shadowUntil: new Date() });
    const withProposal = await insertRuleRow(ctx.db, { slug: "rn-com-proposta", status: "shadow", shadowUntil: new Date() });
    await ctx.db.insert(agentProposals).values({
      id: newId("prp"), kind: "promote_rule", target: withProposal.id, payload: { ruleId: withProposal.id }, evidence: [],
    });

    const families = await listRuleFamilies(ctx.db);
    expect(families.find((f) => f.slug === "rn-sem-proposta")?.versions[0]?.hasPendingPromotionProposal).toBe(false);
    expect(families.find((f) => f.slug === "rn-com-proposta")?.versions[0]?.hasPendingPromotionProposal).toBe(true);
    void withoutProposal;
  });
});

describe("listProposals", () => {
  it("returns only pending proposals by default, newest first", async () => {
    const older = newId("prp");
    const newer = newId("prp");
    const decided = newId("prp");
    await ctx.db.insert(agentProposals).values([
      { id: older, kind: "promote_rule", target: "rul_x", payload: {}, evidence: [], createdAt: new Date("2026-08-01T00:00:00Z") },
      { id: newer, kind: "promote_rule", target: "rul_y", payload: {}, evidence: [], createdAt: new Date("2026-08-02T00:00:00Z") },
      { id: decided, kind: "promote_rule", target: "rul_z", payload: {}, evidence: [], status: "approved", createdAt: new Date("2026-08-03T00:00:00Z") },
    ]);

    const pending = await listProposals(ctx.db, { includeDecided: false });
    expect(pending.map((p) => p.id)).toEqual([newer, older]);
  });

  it("includes decided proposals, still newest first, when includeDecided is true", async () => {
    const older = newId("prp");
    const decided = newId("prp");
    await ctx.db.insert(agentProposals).values([
      { id: older, kind: "promote_rule", target: "rul_x", payload: {}, evidence: [], createdAt: new Date("2026-08-01T00:00:00Z") },
      { id: decided, kind: "promote_rule", target: "rul_z", payload: {}, evidence: [], status: "approved", createdAt: new Date("2026-08-03T00:00:00Z") },
    ]);

    const all = await listProposals(ctx.db, { includeDecided: true });
    expect(all.map((p) => p.id)).toEqual([decided, older]);
  });
});

describe("rejectProposal", () => {
  async function insertPendingProposal(target: string): Promise<string> {
    const id = newId("prp");
    await ctx.db.insert(agentProposals).values({
      id, kind: "promote_rule", target, payload: { ruleId: target }, evidence: ["fired=30"],
    });
    return id;
  }

  it("writes proposal_decided, marks the proposal rejected, and leaves the rule alone", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-proposta", status: "shadow", shadowUntil: new Date() });
    const proposalId = await insertPendingProposal(rule.id);
    const [before] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));

    await rejectProposal(ctx.db, { proposalId, decidedBy: "admin-teste", decisionReason: "Ratio ainda incerto." });

    const [proposalRow] = await ctx.db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    expect(proposalRow?.status).toBe("rejected");
    expect(proposalRow?.decidedBy).toBe("admin-teste");
    expect(proposalRow?.decisionReason).toBe("Ratio ainda incerto.");

    const [evt] = await ctx.db.select().from(events).where(eq(events.type, "proposal_decided"));
    expect(evt?.payload).toMatchObject({ proposalId, decidedBy: "admin-teste", status: "rejected" });

    const [after] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(after).toEqual(before);
  });

  it("refuses a second decision on the same proposal", async () => {
    const rule = await insertRuleRow(ctx.db, { slug: "rn-proposta-dupla", status: "shadow", shadowUntil: new Date() });
    const proposalId = await insertPendingProposal(rule.id);
    await rejectProposal(ctx.db, { proposalId, decidedBy: "admin-teste", decisionReason: "primeira decisão" });

    await expect(
      rejectProposal(ctx.db, { proposalId, decidedBy: "outro-admin", decisionReason: "segunda decisão" }),
    ).rejects.toThrow(/"rejected"/);
  });

  it("refuses a proposal id that does not exist", async () => {
    await expect(
      rejectProposal(ctx.db, { proposalId: newId("prp"), decidedBy: "admin-teste", decisionReason: "x" }),
    ).rejects.toThrow(/no agent_proposals row/);
  });
});

describe("adminOverview", () => {
  it("returns zeroes on an empty database rather than throwing", async () => {
    const overview = await adminOverview(ctx.db, { now: new Date("2026-09-03T15:00:00.000Z") });
    expect(overview).toEqual({
      invoicesToday: {},
      aiCostToday: { calls: 0, costUsd: 0 },
      stalledCases: 0,
      shadowFindings: 0,
      seoPages: {},
    });
  });

  it("counts invoices since local (America/Sao_Paulo) midnight, AI cost, stalled cases, shadow findings and seo pages by status", async () => {
    const userId = newId("usr");
    await ctx.db.insert(users).values({ id: userId, email: "conta@example.com" });
    const issuerId = newId("iss");
    await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Issuer" });
    const ruleA = await insertRuleRow(ctx.db, { slug: "rn-overview-a", status: "shadow", shadowUntil: new Date() });
    const ruleB = await insertRuleRow(ctx.db, { slug: "rn-overview-b", status: "active" });

    // "now" is 15:00 UTC on 2026-09-03. Local midnight (America/Sao_Paulo,
    // UTC-3 fixed) for that day is 2026-09-03T03:00:00Z.
    const now = new Date("2026-09-03T15:00:00.000Z");
    const beforeMidnight = new Date("2026-09-03T02:00:00.000Z"); // still 2026-09-02, local
    const afterMidnight = new Date("2026-09-03T04:00:00.000Z"); // 2026-09-03, local

    const oldInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: oldInvoiceId, userId, issuerId, contentHash: "h1", source: "pdf_text", status: "analyzed",
      createdAt: beforeMidnight,
    });
    await ctx.db.insert(invoices).values({
      id: newId("inv"), userId, issuerId, contentHash: "h2", source: "pdf_text", status: "analyzed",
      createdAt: afterMidnight,
    });
    await ctx.db.insert(invoices).values({
      id: newId("inv"), userId, issuerId, contentHash: "h3", source: "pdf_text", status: "needs_review",
      createdAt: afterMidnight,
    });

    await ctx.db.insert(aiCalls).values([
      {
        id: newId("aic"), purpose: "extract", provider: "openai", model: "gpt", tokensIn: 10, tokensOut: 10,
        costUsd: 0.05, latencyMs: 100, createdAt: beforeMidnight,
      },
      {
        id: newId("aic"), purpose: "extract", provider: "openai", model: "gpt", tokensIn: 10, tokensOut: 10,
        costUsd: 0.1, latencyMs: 100, createdAt: afterMidnight,
      },
      {
        id: newId("aic"), purpose: "extract", provider: "openai", model: "gpt", tokensIn: 10, tokensOut: 10,
        costUsd: 0.2, latencyMs: 100, createdAt: afterMidnight,
      },
    ]);

    await ctx.db.insert(cases).values([
      {
        id: newId("cas"), userId, invoiceId: oldInvoiceId, issuerId, findingIds: [],
        nextDeadlineAt: new Date("2026-09-01T00:00:00Z"), // past, open -> stalled
      },
      {
        id: newId("cas"), userId, invoiceId: oldInvoiceId, issuerId, findingIds: [],
        nextDeadlineAt: new Date("2026-12-01T00:00:00Z"), // future, open -> not stalled
      },
      {
        id: newId("cas"), userId, invoiceId: oldInvoiceId, issuerId, findingIds: [],
        stage: "closed", nextDeadlineAt: new Date("2026-01-01T00:00:00Z"), // past but closed -> not stalled
      },
    ]);

    await ctx.db.insert(findings).values([
      { id: newId("fnd"), invoiceId: oldInvoiceId, ruleId: ruleA.id, ruleVersion: 1, confidence: 0.9, amountCents: 100, shadow: true },
      { id: newId("fnd"), invoiceId: oldInvoiceId, ruleId: ruleB.id, ruleVersion: 1, confidence: 0.9, amountCents: 100, shadow: false },
    ]);

    await ctx.db.insert(seoPages).values([
      { id: newId("seo"), issuerId, chargeSlug: "a", title: "A", bodyMd: "...", status: "draft" },
      { id: newId("seo"), issuerId, chargeSlug: "b", title: "B", bodyMd: "...", status: "published" },
      { id: newId("seo"), issuerId, chargeSlug: "c", title: "C", bodyMd: "...", status: "published" },
    ]);

    const overview = await adminOverview(ctx.db, { now });

    expect(overview.invoicesToday).toEqual({ analyzed: 1, needs_review: 1 });
    expect(overview.aiCostToday).toEqual({ calls: 2, costUsd: 0.1 + 0.2 });
    expect(overview.stalledCases).toBe(1);
    expect(overview.shadowFindings).toBe(1);
    expect(overview.seoPages).toEqual({ draft: 1, published: 2 });
  });
});

describe("global constraint 7 — exactly one promotion path", () => {
  it("packages/db/src/admin.ts never writes rules.status to \"active\"", () => {
    const adminSrcPath = fileURLToPath(new URL("../src/admin.ts", import.meta.url));
    const source = readFileSync(adminSrcPath, "utf8");
    expect(source).not.toContain('status: "active"');
  });
});
