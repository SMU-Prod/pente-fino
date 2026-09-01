import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { InvoiceCanonical, RULE_KINDS, type ActiveRule, type Finding } from "@pentefino/core";
import {
  arithmetic, confirm, confirmAnswerKey, delta, pattern, reference, threshold,
  type EvaluationContext,
} from "@pentefino/core/rules/evaluators";
import { createTestDb, type TestDb } from "../../testing.js";
import { rules } from "../../schema.js";
import { DETERMINISTIC_RULES, seedDeterministicRules, RN_001 } from "./deterministic.js";
import { DETERMINISTIC_FIXTURES } from "./deterministic.fixtures.js";

const ALL_SLUGS = DETERMINISTIC_RULES.map((r) => r.slug);

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

async function deterministicRows() {
  return ctx.db.select().from(rules).where(inArray(rules.slug, ALL_SLUGS));
}

describe("seedDeterministicRules", () => {
  it("is already wired into seedAll: createTestDb's db has every deterministic rule", async () => {
    const rows = await deterministicRows();
    expect(rows.map((r) => r.slug).sort()).toEqual([...ALL_SLUGS].sort());
  });

  it("has one row per slug, with no slug seeded twice", () => {
    expect(new Set(ALL_SLUGS).size).toBe(ALL_SLUGS.length);
  });

  it("gives every rule shadow status, never draft/active/paused (RF-125)", async () => {
    const rows = await deterministicRows();
    expect(rows).toHaveLength(ALL_SLUGS.length);
    expect(rows.every((r) => r.status === "shadow")).toBe(true);
  });

  it("sets a ~7-day shadowUntil on first insert", async () => {
    const rows = await deterministicRows();
    const now = Date.now();
    for (const row of rows) {
      expect(row.shadowUntil).not.toBeNull();
      const deltaMs = row.shadowUntil!.getTime() - now;
      // Generous window: this only guards against "forgot to set it" (null)
      // or "set it to the wrong unit" (e.g. 7 ms or 7 minutes), not exact
      // timing.
      expect(deltaMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      expect(deltaMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    }
  });

  it("gives every rule a non-empty legalBasis with a valid effect (RF-129/RF-161)", async () => {
    const rows = await deterministicRows();
    const validEffects = ["dobro", "suspensao", "cancelamento", "amostra_gratis", "vedada", "limite"];
    for (const row of rows) {
      expect(row.legalBasis.length).toBeGreaterThan(0);
      for (const ref of row.legalBasis) {
        expect(ref.law.length).toBeGreaterThan(0);
        expect(ref.article.length).toBeGreaterThan(0);
        expect(validEffects).toContain(ref.effect);
      }
    }
  });

  it("keeps the kind column consistent with spec.kind, and both are valid RuleKind values", async () => {
    const rows = await deterministicRows();
    for (const row of rows) {
      expect(RULE_KINDS).toContain(row.kind);
      expect(row.kind).toBe(row.spec.kind);
    }
  });

  it("names its parent PRD rule in every reason, so a split rule still traces back to §12.1", () => {
    for (const rule of DETERMINISTIC_RULES) {
      expect(rule.reason).toMatch(/^RN-\d{3} \(PRD §12\.1\)/);
    }
  });

  it("is idempotent: seeding twice does not duplicate rows", async () => {
    await seedDeterministicRules(ctx.db);
    await seedDeterministicRules(ctx.db);
    expect(await deterministicRows()).toHaveLength(ALL_SLUGS.length);
  });

  it("refreshes content on reseed but leaves status/shadowUntil alone, so a redeploy cannot undo RF-126/127's promotion or pause", async () => {
    // Simulate RF-126 having promoted RN-001 to active for real, with a
    // cleared shadowUntil, sometime after the original seed.
    await ctx.db.update(rules).set({ status: "active", shadowUntil: null }).where(eq(rules.slug, RN_001));

    await seedDeterministicRules(ctx.db);

    const [promoted] = await ctx.db.select().from(rules).where(eq(rules.slug, RN_001));
    expect(promoted?.status).toBe("active");
    expect(promoted?.shadowUntil).toBeNull();
  });
});

describe("DETERMINISTIC_FIXTURES", () => {
  it("has exactly one fixture pair per seeded rule, no more, no fewer", () => {
    expect(Object.keys(DETERMINISTIC_FIXTURES).sort()).toEqual([...ALL_SLUGS].sort());
  });

  for (const rule of DETERMINISTIC_RULES) {
    describe(rule.slug, () => {
      const pair = DETERMINISTIC_FIXTURES[rule.slug]!;

      it("has a firing invoice that parses as a valid InvoiceCanonical", () => {
        expect(() => InvoiceCanonical.parse(pair.fires.invoice)).not.toThrow();
        if (pair.fires.previous) {
          expect(() => InvoiceCanonical.parse(pair.fires.previous)).not.toThrow();
        }
      });

      it("has a non-firing (clean) invoice that parses as a valid InvoiceCanonical", () => {
        expect(() => InvoiceCanonical.parse(pair.clean.invoice)).not.toThrow();
        if (pair.clean.previous) {
          expect(() => InvoiceCanonical.parse(pair.clean.previous)).not.toThrow();
        }
      });

      it("the firing and clean scenarios are meaningfully different", () => {
        expect(JSON.stringify(pair.fires)).not.toBe(JSON.stringify(pair.clean));
      });
    });
  }
});

/**
 * Dispatch by `spec.kind`, standing in for the engine until Task 4 wires
 * `runRules` to these same evaluators (see `evaluators/index.test.ts`, which
 * already calls that module the engine's dispatch surface). Written here as
 * an exhaustive switch rather than a lookup object so a new `RuleSpec` kind
 * becomes a TypeScript error in this file instead of a rule that silently
 * evaluates to nothing.
 */
function evaluate(rule: ActiveRule, ctx: EvaluationContext): Finding[] {
  switch (rule.spec.kind) {
    case "pattern": return pattern(rule, ctx);
    case "threshold": return threshold(rule, ctx);
    case "arithmetic": return arithmetic(rule, ctx);
    case "delta": return delta(rule, ctx);
    case "reference": return reference(rule, ctx);
    case "confirm": return confirm(rule, ctx);
    case "suppressor":
      // RF-121's seventh kind suppresses other rules' findings rather than
      // producing its own, so it has no evaluator to route to. No §12.1 rule
      // uses it; reaching this line means one started to.
      throw new Error(`suppressor rules are not evaluated directly (${rule.slug})`);
  }
}

function activeRule(entry: (typeof DETERMINISTIC_RULES)[number]): ActiveRule {
  return {
    slug: entry.slug,
    version: 1,
    spec: entry.spec,
    confidenceBase: entry.confidenceBase,
    shadow: true,
    legalBasis: entry.legalBasis,
    issuerId: null,
  };
}

function contextFor(
  rule: ActiveRule,
  scenario: { invoice: EvaluationContext["invoice"]; previous: EvaluationContext["previous"]; answer?: string },
): EvaluationContext {
  return {
    invoice: scenario.invoice,
    previous: scenario.previous,
    references: { tariffs: [], flags: [] },
    // Keyed exactly as `confirm` reads it, built by the evaluator's own
    // helper so this test cannot drift from the key format.
    answers: scenario.answer === undefined ? {} : { [confirmAnswerKey(rule, null)]: scenario.answer },
  };
}

/**
 * The claim this whole seed rests on: each rule, run by the real evaluator
 * for its kind, fires on its own firing fixture and stays silent on its
 * clean one. Task 5 could only assert that the engine stub threw; with the
 * evaluators landed, every rule is now exercised end to end.
 */
describe("end-to-end evaluation with the real evaluators", () => {
  for (const entry of DETERMINISTIC_RULES) {
    describe(entry.slug, () => {
      const rule = activeRule(entry);
      const pair = DETERMINISTIC_FIXTURES[entry.slug]!;

      it("fires on its firing fixture, with the value the rule is about", () => {
        const findings = evaluate(rule, contextFor(rule, pair.fires));

        expect(findings).toHaveLength(1);
        const [finding] = findings;
        expect(finding!.ruleSlug).toBe(entry.slug);
        expect(finding!.amountCents).toBe(pair.firesAmountCents);
        // RF-129: a finding never carries a bare accusation - the citation
        // comes from the rule, and the evidence from the invoice.
        expect(finding!.legalBasis).toEqual(entry.legalBasis);
        expect(finding!.evidence.length).toBeGreaterThan(0);
        expect(finding!.shadow).toBe(true);
        expect(finding!.confidence).toBe(entry.confidenceBase);
      });

      it("stays silent on its clean fixture", () => {
        expect(evaluate(rule, contextFor(rule, pair.clean))).toEqual([]);
      });
    });
  }

  it("evaluates every seeded rule without an ExpressionError, proving no spec has a typo'd field or function name", () => {
    // A bad *field* name throws at parse time on every invoice; a bad
    // *section* name is silent missing data. The fire/no-fire assertions
    // above are what catch the silent half - this one states the loud half
    // as its own claim, over both fixtures of every rule.
    for (const entry of DETERMINISTIC_RULES) {
      const rule = activeRule(entry);
      const pair = DETERMINISTIC_FIXTURES[entry.slug]!;
      expect(() => evaluate(rule, contextFor(rule, pair.fires))).not.toThrow();
      expect(() => evaluate(rule, contextFor(rule, pair.clean))).not.toThrow();
    }
  });

  it("keeps every section its rule reads present in the clean fixture, so 'stays silent' never means 'never ran'", () => {
    // The failure this guards against: a clean fixture that passes because
    // the rule could not find its data at all, which would pass just as
    // happily if the rule were nonsense. `sectionTotal`/`sectionCount` on an
    // absent section is missing data, and missing data means no finding -
    // silently, forever (see `deterministic.ts`'s header).
    //
    // RN-003 is the one deliberate exception, spelled out below rather than
    // skipped: an invoice consuming above the phase minimum genuinely has no
    // availability line, and that absence *is* the clean case.
    const EXPECTED_ABSENT: Record<string, string[]> = {
      "rn-003-custo-disponibilidade": ["Custo de Disponibilidade"],
    };

    for (const entry of DETERMINISTIC_RULES) {
      const spec = entry.spec;
      const sources =
        spec.kind === "threshold" ? [spec.expr]
        : spec.kind === "arithmetic" ? [spec.formula, spec.expect]
        : [];
      if (sources.length === 0) continue;

      const referenced = new Set(
        sources.flatMap((source) => [...source.matchAll(/section(?:Total|Count)\("([^"]+)"\)/g)]
          .map((match) => match[1]!)),
      );
      const cleanSections = new Set(
        DETERMINISTIC_FIXTURES[entry.slug]!.clean.invoice.sections.map((s) => s.name),
      );
      const absent = EXPECTED_ABSENT[entry.slug] ?? [];

      for (const section of referenced) {
        if (absent.includes(section)) {
          expect(cleanSections.has(section), `${entry.slug} expects "${section}" absent`).toBe(false);
        } else {
          expect(cleanSections.has(section), `${entry.slug} needs "${section}" present`).toBe(true);
        }
      }
    }
  });

  it("produces a question, not an accusation, for the two rules that cannot be calculated", () => {
    // RN-005 and RN-006 turn on facts no evaluator can read, so they are
    // seeded as `confirm`. Unanswered, each must ask rather than assert -
    // RF-124's whole point, and the reason neither was left as a formula.
    const confirmRules = DETERMINISTIC_RULES.filter((r) => r.spec.kind === "confirm");
    expect(confirmRules.map((r) => r.slug)).toEqual([
      "rn-005-media-sem-acerto-agua",
      "rn-006-encargo-fatura-paga",
    ]);

    for (const entry of confirmRules) {
      const rule = activeRule(entry);
      const pair = DETERMINISTIC_FIXTURES[entry.slug]!;
      const unanswered = evaluate(rule, {
        ...contextFor(rule, pair.fires),
        answers: {},
      });

      expect(unanswered).toHaveLength(1);
      expect(unanswered[0]!.askUser?.question).toBe(
        entry.spec.kind === "confirm" ? entry.spec.question : undefined,
      );
      // A question is not yet a claim about money.
      expect(unanswered[0]!.amountCents).toBe(0);
    }
  });
});
