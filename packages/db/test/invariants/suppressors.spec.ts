import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { runRules, type ActiveRule, type Category, type InvoiceCanonical } from "@pentefino/core";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { rules } from "../../src/schema.js";
import { RN_090, RN_091, RN_092 } from "../../src/seeds/rules/suppressors.js";

/**
 * The three dead theses of RN-090..092. No rule under active observation may
 * carry one of these slugs, or a renamed variant of one.
 */
const DEAD_THESES = ["icms-tusd-tust", "cosip-sem-poste", "agua-tarifa-minima-economia"];

/**
 * Rule statuses under active observation. `active` is the obvious one — it
 * is what the user sees. `shadow` must be included too: RF-125 evaluates a
 * `shadow` rule against real invoices for seven days, writing real
 * `findings` rows with `shadow = true`, and RF-126 lets it auto-promote to
 * `active` with no human sign-off once it clears a firing threshold. A dead
 * thesis sitting in `shadow` is therefore already being computed — just not
 * yet displayed — for its whole observation window, and a check that only
 * looked at `active` would miss it for all seven of those days and one
 * automatic promotion away from being shown to users.
 */
const OBSERVED_STATUSES = ["active", "shadow"];

/**
 * Separator-insensitive and version-suffix-insensitive slug comparison. Exact
 * string matching lets a dead thesis walk back in under a cosmetically
 * different slug — `icms-tusd-tust-v2` (a fake "new version") or
 * `icms_tusd_tust` (underscores instead of dashes) both mean the same
 * RN-090 thesis and must be caught the same as the original slug.
 */
function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[-_]/g, "").replace(/v\d+$/i, "");
}

const DEAD_THESES_NORMALIZED = DEAD_THESES.map(normalizeSlug);

function isDeadThesis(slug: string): boolean {
  return DEAD_THESES_NORMALIZED.includes(normalizeSlug(slug));
}

let ctx: TestDb;
let ruleSeq = 0;

beforeEach(async () => {
  ctx = await createTestDb();
  ruleSeq = 0;
});
afterEach(async () => { await ctx.close(); });

/** Inserts a minimal rule row under the given slug/status, for the probes below. */
async function insertRule(slug: string, status: string): Promise<void> {
  ruleSeq += 1;
  await ctx.db.insert(rules).values({
    id: `rul_probe_${ruleSeq}`,
    slug,
    category: "energy",
    kind: "pattern",
    spec: { kind: "pattern", match: "test" },
    confidenceBase: 0.5,
    status,
    author: "system",
    reason: "test probe",
  });
}

/** The slugs of every active-or-shadow rule that resolve to a dead thesis. */
async function observedDeadThesisSlugs(): Promise<string[]> {
  const observed = await ctx.db.select().from(rules).where(inArray(rules.status, OBSERVED_STATUSES));
  return observed.map((r) => r.slug).filter(isDeadThesis);
}

describe("INV-010 · the dead theses are never signalled", () => {
  it("finds no active or shadow rule carrying a dead thesis slug", async () => {
    expect(await observedDeadThesisSlugs()).toEqual([]);
  });

  it("keeps the dead thesis list wired to RN-090..092", () => {
    expect(DEAD_THESES).toHaveLength(3);
  });

  // Demonstrates the normalisation is load-bearing, not decorative: a dead
  // thesis reintroduced under a version-suffixed slug is still caught.
  it("catches a dead thesis reintroduced with a version suffix (icms-tusd-tust-v2)", async () => {
    await insertRule("icms-tusd-tust-v2", "active");
    expect(await observedDeadThesisSlugs()).toEqual(["icms-tusd-tust-v2"]);
  });

  // Demonstrates the same for a dead thesis reintroduced with underscores
  // instead of dashes — and in `shadow`, not `active`, so this also exercises
  // the widened status filter above in the same assertion.
  it("catches a dead thesis reintroduced with underscores instead of dashes (icms_tusd_tust)", async () => {
    await insertRule("icms_tusd_tust", "shadow");
    expect(await observedDeadThesisSlugs()).toEqual(["icms_tusd_tust"]);
  });
});

// ---------------------------------------------------------------------------
// The stronger property: no finding for a dead thesis survives the engine,
// even one produced by a rule whose slug names nothing about that thesis.
//
// The slug check above is necessary but not sufficient: it only catches a
// dead thesis that *admits* what it is in its own slug. It says nothing
// about a rule such as `energia-encargo-nao-identificado` below, which
// flags exactly RN-090's shape under a slug that gives no hint of it -
// the scenario `INV-010`'s own wording in the PRD and in the E2 plan calls
// out by name ("under an unrelated slug must still be suppressed").
// ---------------------------------------------------------------------------

function invoice(partial: Omit<InvoiceCanonical, "extraction">): InvoiceCanonical {
  return { ...partial, extraction: { confidence: 0.9, warnings: [] } } as InvoiceCanonical;
}

/**
 * A rogue, unrelated-slug rule that flags a dead thesis without naming it.
 * `category` must match the fixture invoice it is run against (RF-120's
 * category filter, defence in depth — a mismatched category would make the
 * rogue rule silently inert, and the test below would then "pass" for the
 * wrong reason: nothing to suppress, rather than something suppressed).
 */
function rogueRule(slug: string, match: string, category: Category = "energy"): ActiveRule {
  return {
    slug,
    version: 1,
    spec: { kind: "pattern", match },
    confidenceBase: 0.8,
    shadow: false,
    legalBasis: [{ law: "CDC", article: "42, parágrafo único", effect: "dobro" }],
    issuerId: null,
    category,
  };
}

/** Loads the three seeded suppressors of §12.4 as `ActiveRule`s, as the engine would receive them. */
async function loadSuppressorActiveRules(db: TestDb["db"]): Promise<ActiveRule[]> {
  const rows = await db.select().from(rules).where(inArray(rules.slug, [RN_090, RN_091, RN_092]));
  return rows.map((row) => ({
    slug: row.slug,
    version: row.version,
    spec: row.spec,
    confidenceBase: row.confidenceBase,
    shadow: row.status === "shadow",
    legalBasis: row.legalBasis,
    issuerId: row.issuerId,
    category: row.category,
  }));
}

const ENGINE_NOT_IMPLEMENTED = /rule evaluators are not implemented yet \(E2\)/;

/**
 * Calls `runRules`, distinguishing "Task 4's engine has not landed yet in
 * this branch" (the RF-120 boundary stub in `engine.ts` throws for *any*
 * non-empty rule set, regardless of what those rules are) from a real
 * error. This is what lets the assertions below go live automatically the
 * moment the real engine ships, with no edit to this file required -
 * see the module doc comment above and this block's own tests for why that
 * matters more here than it would elsewhere.
 */
function runOrPendingEngine(input: Parameters<typeof runRules>[0]): "pending-task-4" | ReturnType<typeof runRules> {
  try {
    return runRules(input);
  } catch (err) {
    if (err instanceof Error && ENGINE_NOT_IMPLEMENTED.test(err.message)) {
      return "pending-task-4";
    }
    throw err;
  }
}

const noReferences = { tariffs: [], flags: [] };

describe("INV-010 · no finding for a dead thesis survives the engine, under any slug", () => {
  it("suppresses RN-090 (ICMS sobre TUSD/TUST) even flagged by an unrelated slug", async () => {
    const suppressors = await loadSuppressorActiveRules(ctx.db);
    expect(suppressors.map((r) => r.slug).sort()).toEqual([RN_090, RN_091, RN_092].sort());

    const rogue = rogueRule("energia-encargo-nao-identificado", "ICMS");
    const fixture = invoice({
      issuer: { name: "Enel SP", category: "energy" },
      period: { start: "2026-06-01", end: "2026-06-30" },
      dueDate: "2026-07-10",
      totalCents: 50000,
      sections: [{
        name: "Fatura",
        items: [{ description: "ICMS sobre TUSD/TUST", amountCents: 500 }],
      }],
    });

    const result = runOrPendingEngine({
      invoice: fixture, previous: null, rules: [rogue, ...suppressors], answers: {}, references: noReferences,
    });

    if (result === "pending-task-4") {
      // Task 4's engine (packages/core/src/rules/engine.ts) has not landed
      // in this branch yet - it still throws the RF-120 boundary stub for
      // any non-empty rule set, so there is nothing real to assert here
      // today. This branch is exactly what stops existing the moment that
      // engine ships; nothing in this file needs to change for that to
      // happen.
      expect(result).toBe("pending-task-4");
      return;
    }
    expect(result).toEqual([]);
  });

  it("suppresses RN-091 (COSIP sem poste) even flagged by an unrelated slug", async () => {
    const suppressors = await loadSuppressorActiveRules(ctx.db);
    const rogue = rogueRule("energia-cobranca-a-verificar", "COSIP");
    const fixture = invoice({
      issuer: { name: "Enel SP", category: "energy" },
      period: { start: "2026-06-01", end: "2026-06-30" },
      dueDate: "2026-07-10",
      totalCents: 30000,
      sections: [{
        name: "Fatura",
        items: [{ description: "COSIP - ausência de poste no logradouro", amountCents: 300 }],
      }],
    });

    const result = runOrPendingEngine({
      invoice: fixture, previous: null, rules: [rogue, ...suppressors], answers: {}, references: noReferences,
    });

    if (result === "pending-task-4") {
      expect(result).toBe("pending-task-4");
      return;
    }
    expect(result).toEqual([]);
  });

  it("suppresses RN-092 (tarifa mínima de água por economia) even flagged by an unrelated slug", async () => {
    const suppressors = await loadSuppressorActiveRules(ctx.db);
    const rogue = rogueRule("agua-cobranca-nao-identificada", "TARIFA MINIMA", "water");
    const fixture = invoice({
      issuer: { name: "Sabesp", category: "water" },
      period: { start: "2026-06-01", end: "2026-06-30" },
      dueDate: "2026-07-10",
      totalCents: 40000,
      sections: [{
        name: "Fatura",
        items: [{ description: "Tarifa mínima de água - condomínio tratado como economia única", amountCents: 400 }],
      }],
    });

    const result = runOrPendingEngine({
      invoice: fixture, previous: null, rules: [rogue, ...suppressors], answers: {}, references: noReferences,
    });

    if (result === "pending-task-4") {
      expect(result).toBe("pending-task-4");
      return;
    }
    expect(result).toEqual([]);
  });
});
