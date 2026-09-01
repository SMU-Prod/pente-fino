import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  InvoiceCanonical, RULE_KINDS, runRules, type ActiveRule,
} from "@pentefino/core";
import { createTestDb, type TestDb } from "../../testing.js";
import { rules } from "../../schema.js";
import {
  DETERMINISTIC_RULES, seedDeterministicRules,
  RN_001, RN_002, RN_003, RN_004, RN_005, RN_006, RN_007, RN_008, RN_009, RN_010, RN_011,
} from "./deterministic.js";
import { DETERMINISTIC_FIXTURES } from "./deterministic.fixtures.js";

const ALL_SLUGS = [
  RN_001, RN_002, RN_003, RN_004, RN_005, RN_006, RN_007, RN_008, RN_009, RN_010, RN_011,
];

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

async function deterministicRows() {
  return ctx.db.select().from(rules).where(inArray(rules.slug, ALL_SLUGS));
}

describe("seedDeterministicRules", () => {
  it("is already wired into seedAll: createTestDb's db has all eleven RN-001..011 rules", async () => {
    const rows = await deterministicRows();
    expect(rows.map((r) => r.slug).sort()).toEqual([...ALL_SLUGS].sort());
  });

  it("gives every rule shadow status, never draft/active/paused (RF-125)", async () => {
    const rows = await deterministicRows();
    expect(rows).toHaveLength(11);
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

  it("is idempotent: seeding twice does not duplicate rows", async () => {
    await seedDeterministicRules(ctx.db);
    await seedDeterministicRules(ctx.db);
    expect(await deterministicRows()).toHaveLength(11);
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
    expect(Object.keys(DETERMINISTIC_FIXTURES).sort()).toEqual(
      DETERMINISTIC_RULES.map((r) => r.slug).sort(),
    );
  });

  for (const rule of DETERMINISTIC_RULES) {
    describe(rule.slug, () => {
      const pair = DETERMINISTIC_FIXTURES[rule.slug];

      it("has a firing invoice that parses as a valid InvoiceCanonical", () => {
        expect(() => InvoiceCanonical.parse(pair!.fires.invoice)).not.toThrow();
        if (pair!.fires.previous) {
          expect(() => InvoiceCanonical.parse(pair!.fires.previous)).not.toThrow();
        }
      });

      it("has a non-firing (clean) invoice that parses as a valid InvoiceCanonical", () => {
        expect(() => InvoiceCanonical.parse(pair!.clean.invoice)).not.toThrow();
        if (pair!.clean.previous) {
          expect(() => InvoiceCanonical.parse(pair!.clean.previous)).not.toThrow();
        }
      });

      it("the firing and clean invoices are meaningfully different", () => {
        expect(JSON.stringify(pair!.fires)).not.toBe(JSON.stringify(pair!.clean));
      });
    });
  }
});

describe("end-to-end evaluation against runRules", () => {
  // RF-121's six evaluators (pattern/delta/threshold/reference/confirm/
  // arithmetic) are Tasks 1/2 of this block, running in parallel with this
  // seed — as of this test, `runRules` is still the RF-120 boundary stub
  // that throws for any non-empty rule set (see packages/core/src/rules/
  // engine.ts and its own engine.test.ts). So none of these eleven rules can
  // be exercised end to end yet: this test documents that fact precisely,
  // rather than silently skipping it, and should be replaced with real
  // fire/no-fire assertions (one per rule, using the fixtures above) once a
  // real evaluator lands.
  it("still throws the E2-not-implemented stub, naming every deterministic rule", () => {
    const activeRules: ActiveRule[] = DETERMINISTIC_RULES.map((r) => ({
      slug: r.slug,
      version: 1,
      spec: r.spec,
      confidenceBase: r.confidenceBase,
      shadow: true,
      legalBasis: r.legalBasis,
      issuerId: null,
    }));
    const { invoice, previous } = DETERMINISTIC_FIXTURES[RN_001]!.fires;

    expect(() =>
      runRules({
        invoice,
        previous,
        rules: activeRules,
        answers: {},
        references: { tariffs: [], flags: [] },
      }),
    ).toThrow(/E2/);
  });
});
