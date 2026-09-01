import { describe, expect, it } from "vitest";
import { threshold } from "./threshold.js";
import type { ActiveRule } from "../engine.js";
import type { RuleSpec } from "../spec.js";
import type { EvaluationContext } from "./types.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";

function rule(spec: RuleSpec, overrides: Partial<ActiveRule> = {}): ActiveRule {
  return {
    slug: "teto-cartao",
    version: 1,
    spec,
    confidenceBase: 0.85,
    shadow: false,
    legalBasis: [{ law: "Lei 14.690/2023", article: "1º", effect: "limite" }],
    issuerId: null,
    ...overrides,
  };
}

function ctx(invoice: Partial<InvoiceCanonical>): EvaluationContext {
  return {
    invoice: {
      issuer: { name: "Banco X", category: "card" },
      period: { start: "2026-07-01", end: "2026-07-31" },
      dueDate: "2026-08-10",
      totalCents: 10000,
      sections: [{ name: "Encargos", items: [{ description: "Juros", amountCents: 500 }] }],
      extraction: { confidence: 0.9, warnings: [] },
      ...invoice,
    } as InvoiceCanonical,
    previous: null,
    references: { tariffs: [], flags: [] },
    answers: {},
  };
}

describe("threshold evaluator", () => {
  it("fires when the expression satisfies the operator/value comparison (positive, RF-121)", () => {
    const spec: RuleSpec = { kind: "threshold", expr: "total", operator: ">", value: 5000 };
    const findings = threshold(rule(spec), ctx({ totalCents: 10000 }));
    expect(findings).toHaveLength(1);
  });

  it("does not fire when the comparison is false (negative, RF-121)", () => {
    const spec: RuleSpec = { kind: "threshold", expr: "total", operator: ">", value: 50000 };
    expect(threshold(rule(spec), ctx({ totalCents: 10000 }))).toEqual([]);
  });

  it.each([
    [">", 6, 5, true],
    [">", 5, 5, false],
    ["<", 4, 5, true],
    ["<", 5, 5, false],
    [">=", 5, 5, true],
    [">=", 4, 5, false],
    ["<=", 5, 5, true],
    ["<=", 6, 5, false],
  ] as const)("operator %s: value %d vs threshold %d fires=%s", (operator, exprValue, thresholdValue, shouldFire) => {
    const spec: RuleSpec = { kind: "threshold", expr: "total", operator, value: thresholdValue };
    const findings = threshold(rule(spec), ctx({ totalCents: exprValue }));
    expect(findings.length > 0).toBe(shouldFire);
  });

  it("produces no finding - rather than crashing - on a field the invoice does not have", () => {
    // A card invoice has no `tariffs`/`readings` block.
    const spec: RuleSpec = { kind: "threshold", expr: "icms", operator: ">", value: 0 };
    expect(threshold(rule(spec), ctx({ tariffs: undefined }))).toEqual([]);
  });

  it("throws immediately on a structurally invalid expression (a rule-authoring bug, not per-invoice data)", () => {
    const spec: RuleSpec = { kind: "threshold", expr: "nome_que_nao_existe", operator: ">", value: 0 };
    expect(() => threshold(rule(spec), ctx({}))).toThrow();
  });

  it("supports counting items in a named section (RN-010's 'more than N withdrawals')", () => {
    const spec: RuleSpec = { kind: "threshold", expr: 'sectionCount("Saques")', operator: ">", value: 4 };
    const findings = threshold(
      rule(spec),
      ctx({
        sections: [
          {
            name: "Saques",
            items: Array.from({ length: 5 }, (_, i) => ({ description: `Saque ${i}`, amountCents: 0 })),
          },
        ],
      }),
    );
    expect(findings).toHaveLength(1);
  });

  it("supports the 'greater of' comparison via max() (RN-003's shape)", () => {
    const spec: RuleSpec = { kind: "threshold", expr: "total - max(30, kwh) * 50", operator: ">", value: 0 };
    // kwh=40 > minimum 30, so expected cost is 40*50=2000, but the invoice
    // charged 2500 - overcharged.
    const findings = threshold(
      rule(spec),
      ctx({ totalCents: 2500, readings: { previous: 0, current: 40, kwh: 40, estimated: false } }),
    );
    expect(findings).toHaveLength(1);
  });

  it("carries evidence and legalBasis from the rule, and never asserts illegality", () => {
    const spec: RuleSpec = { kind: "threshold", expr: "total", operator: ">", value: 0 };
    const legalBasis = [{ law: "Lei 14.690/2023", article: "1º", effect: "limite" as const }];
    const [finding] = threshold(rule(spec, { legalBasis }), ctx({}));
    expect(finding?.legalBasis).toBe(legalBasis);
    const text = finding?.evidence.join(" ") ?? "";
    expect(text).toContain("para você verificar");
    expect(text.toLowerCase()).not.toMatch(/ilegal|indevid/);
  });

  it("sets doubledCents from the rule's legalBasis effect, and reports a non-negative amount", () => {
    const spec: RuleSpec = { kind: "threshold", expr: "-total", operator: "<", value: 0 };
    const [finding] = threshold(
      rule(spec, { legalBasis: [{ law: "CDC", article: "42", effect: "dobro" }] }),
      ctx({ totalCents: 300 }),
    );
    expect(finding?.amountCents).toBe(300);
    expect(finding?.doubledCents).toBe(600);
  });

  it("throws when routed a rule of the wrong kind", () => {
    const spec: RuleSpec = { kind: "pattern", match: "X" };
    expect(() => threshold(rule(spec), ctx({}))).toThrow();
  });
});
