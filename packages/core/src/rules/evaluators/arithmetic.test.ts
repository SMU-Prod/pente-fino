import { describe, expect, it } from "vitest";
import { arithmetic } from "./arithmetic.js";
import type { ActiveRule } from "../engine.js";
import type { RuleSpec } from "../spec.js";
import type { EvaluationContext } from "./types.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";

function rule(spec: RuleSpec, overrides: Partial<ActiveRule> = {}): ActiveRule {
  return {
    slug: "leitura-agua",
    version: 1,
    spec,
    confidenceBase: 0.75,
    shadow: false,
    legalBasis: [{ law: "NR 11/ANA/2024", article: "1º", effect: "limite" }],
    issuerId: null,
    ...overrides,
  };
}

function ctx(invoice: Partial<InvoiceCanonical>): EvaluationContext {
  return {
    invoice: {
      issuer: { name: "Águas SA", category: "water" },
      period: { start: "2026-07-01", end: "2026-07-31" },
      dueDate: "2026-08-10",
      totalCents: 10000,
      sections: [{ name: "Consumo", items: [{ description: "Água", amountCents: 10000 }] }],
      extraction: { confidence: 0.9, warnings: [] },
      ...invoice,
    } as InvoiceCanonical,
    previous: null,
    references: { tariffs: [], flags: [] },
    answers: {},
  };
}

describe("arithmetic evaluator", () => {
  it("fires when formula and expect disagree beyond tolerance (positive, RF-121)", () => {
    const spec: RuleSpec = { kind: "arithmetic", formula: "readingsCurrent - readingsPrevious", expect: "kwh", tolerancePct: 0 };
    const findings = arithmetic(
      rule(spec),
      ctx({ readings: { previous: 100, current: 160, kwh: 50, estimated: false } }), // 60 != 50
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(10);
  });

  it("does not fire when formula and expect agree (negative, RF-121)", () => {
    const spec: RuleSpec = { kind: "arithmetic", formula: "readingsCurrent - readingsPrevious", expect: "kwh", tolerancePct: 0 };
    expect(
      arithmetic(rule(spec), ctx({ readings: { previous: 100, current: 150, kwh: 50, estimated: false } })),
    ).toEqual([]);
  });

  it("produces no finding when an operand is missing, rather than guessing", () => {
    const spec: RuleSpec = { kind: "arithmetic", formula: "readingsCurrent - readingsPrevious", expect: "kwh", tolerancePct: 0 };
    expect(arithmetic(rule(spec), ctx({ readings: undefined }))).toEqual([]);
  });

  describe("tolerance boundary (inclusive - exactly at the edge does not fire)", () => {
    // expect = 1000 cents, tolerancePct = 10 -> allowed deviation = 100 cents exactly,
    // chosen so the percentage math has no rounding to worry about.
    const spec: RuleSpec = { kind: "arithmetic", formula: "total", expect: "sectionTotal(\"Esperado\")", tolerancePct: 10 };

    it("does not fire when the deviation exactly equals the allowed tolerance", () => {
      const context = ctx({
        totalCents: 1100,
        sections: [{ name: "Esperado", items: [{ description: "x", amountCents: 1000 }] }],
      });
      expect(arithmetic(rule(spec), context)).toEqual([]);
    });

    it("fires when the deviation exceeds the allowed tolerance by a single cent", () => {
      const context = ctx({
        totalCents: 1101,
        sections: [{ name: "Esperado", items: [{ description: "x", amountCents: 1000 }] }],
      });
      expect(arithmetic(rule(spec), context)).toHaveLength(1);
    });
  });

  it("keeps money exact in integer cents: sums that would show floating-point error if divided by 100 first still compare exactly", () => {
    // 10 + 20 + 70 cents is exact in double-precision integer math; the
    // classic float bug (0.1 + 0.2 !== 0.3) only appears if someone divides
    // by 100 into reais *before* comparing. This test locks in that the
    // evaluator never does that: it must report an exact match here.
    const spec: RuleSpec = {
      kind: "arithmetic",
      formula: 'sectionTotal("A") + sectionTotal("B") + sectionTotal("C")',
      expect: "total",
      tolerancePct: 0,
    };
    const context = ctx({
      totalCents: 100,
      sections: [
        { name: "A", items: [{ description: "a", amountCents: 10 }] },
        { name: "B", items: [{ description: "b", amountCents: 20 }] },
        { name: "C", items: [{ description: "c", amountCents: 70 }] },
      ],
    });
    expect(arithmetic(rule(spec), context)).toEqual([]);
  });

  it("treats an expected value of zero as requiring exact equality (zero tolerance amount)", () => {
    const spec: RuleSpec = { kind: "arithmetic", formula: "total", expect: "0", tolerancePct: 50 };
    expect(arithmetic(rule(spec), ctx({ totalCents: 0 }))).toEqual([]);
    expect(arithmetic(rule(spec), ctx({ totalCents: 1 }))).toHaveLength(1);
  });

  it("carries evidence and legalBasis from the rule, and never asserts illegality", () => {
    const spec: RuleSpec = { kind: "arithmetic", formula: "readingsCurrent - readingsPrevious", expect: "kwh", tolerancePct: 0 };
    const legalBasis = [{ law: "NR 11/ANA/2024", article: "1º", effect: "limite" as const }];
    const [finding] = arithmetic(
      rule(spec, { legalBasis }),
      ctx({ readings: { previous: 100, current: 160, kwh: 50, estimated: false } }),
    );
    expect(finding?.legalBasis).toBe(legalBasis);
    const text = finding?.evidence.join(" ") ?? "";
    expect(text).toContain("para você verificar");
    expect(text.toLowerCase()).not.toMatch(/ilegal|indevid/);
  });

  it("sets doubledCents from the rule's legalBasis effect", () => {
    const spec: RuleSpec = { kind: "arithmetic", formula: "readingsCurrent - readingsPrevious", expect: "kwh", tolerancePct: 0 };
    const [finding] = arithmetic(
      rule(spec, { legalBasis: [{ law: "CDC", article: "42", effect: "dobro" }] }),
      ctx({ readings: { previous: 100, current: 160, kwh: 50, estimated: false } }),
    );
    expect(finding?.doubledCents).toBe(20);
  });

  it("throws when routed a rule of the wrong kind", () => {
    const spec: RuleSpec = { kind: "pattern", match: "X" };
    expect(() => arithmetic(rule(spec), ctx({}))).toThrow();
  });
});
