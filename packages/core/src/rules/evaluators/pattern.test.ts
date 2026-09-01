import { describe, expect, it } from "vitest";
import { pattern } from "./pattern.js";
import type { ActiveRule } from "../engine.js";
import type { RuleSpec } from "../spec.js";
import type { EvaluationContext } from "./types.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";

function rule(spec: RuleSpec, overrides: Partial<ActiveRule> = {}): ActiveRule {
  return {
    slug: "sva-nao-contratado",
    version: 1,
    spec,
    confidenceBase: 0.8,
    shadow: false,
    legalBasis: [{ law: "CDC", article: "39 III p.u.", effect: "limite" }],
    issuerId: null,
    ...overrides,
  };
}

function ctx(invoice: Partial<InvoiceCanonical>, previous: InvoiceCanonical | null = null): EvaluationContext {
  return {
    invoice: {
      issuer: { name: "Claro Móvel", category: "telecom" },
      period: { start: "2026-07-01", end: "2026-07-31" },
      dueDate: "2026-08-10",
      totalCents: 10000,
      sections: [{ name: "Serviços digitais", items: [{ description: "Plano", amountCents: 10000 }] }],
      extraction: { confidence: 0.9, warnings: [] },
      ...invoice,
    } as InvoiceCanonical,
    previous,
    references: { tariffs: [], flags: [] },
    answers: {},
  };
}

describe("pattern evaluator", () => {
  it("fires on an item whose normalised description matches spec.match (positive, RF-121)", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA" };
    const context = ctx({
      sections: [{ name: "Serviços digitais", items: [{ description: "Serviços de valor adicionado(SVA)", amountCents: 990 }] }],
    });
    const findings = pattern(rule(spec), context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(990);
  });

  it("does not fire when nothing matches (negative, RF-121)", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA" };
    const context = ctx({
      sections: [{ name: "Serviços digitais", items: [{ description: "Plano mensal", amountCents: 5000 }] }],
    });
    expect(pattern(rule(spec), context)).toEqual([]);
  });

  it("matches case- and accent-insensitively via normalizeDescription (RF-122)", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SERVICOS DE VALOR ADICIONADO" };
    const context = ctx({
      sections: [{ name: "Serviços digitais", items: [{ description: "Serviços de valor adicionado(SVA)", amountCents: 990 }] }],
    });
    expect(pattern(rule(spec), context)).toHaveLength(1);
  });

  it("carries evidence and legalBasis straight from the rule (RF-129), never inventing either", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA" };
    const legalBasis = [{ law: "CDC", article: "39 III p.u.", effect: "limite" as const }];
    const context = ctx({
      sections: [{ name: "Serviços digitais", items: [{ description: "SVA Turbo", amountCents: 990 }] }],
    });
    const findings = pattern(rule(spec, { legalBasis }), context);
    expect(findings[0]?.legalBasis).toBe(legalBasis);
    expect(findings[0]?.evidence.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.evidence[0]).toContain("para você verificar");
  });

  it("never asserts illegality in the evidence text (§14.2 vocabulary)", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA" };
    const context = ctx({
      sections: [{ name: "Serviços digitais", items: [{ description: "SVA Turbo", amountCents: 990 }] }],
    });
    const [finding] = pattern(rule(spec), context);
    const text = finding?.evidence.join(" ").toLowerCase() ?? "";
    expect(text).not.toMatch(/ilegal|indevid/);
  });

  it("restricts matching to spec.sections when given", () => {
    const spec: RuleSpec = { kind: "pattern", match: "TAXA", sections: ["Serviços digitais"] };
    const context = ctx({
      sections: [
        { name: "Plano", items: [{ description: "Taxa de plano", amountCents: 100 }] },
        { name: "Serviços digitais", items: [{ description: "Taxa SVA", amountCents: 200 }] },
      ],
    });
    const findings = pattern(rule(spec), context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(200);
  });

  it("excludes an item matched by spec.notMatch even though it also matches spec.match", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA", notMatch: "CANCELADO" };
    const context = ctx({
      sections: [{ name: "Serviços digitais", items: [{ description: "SVA cancelado", amountCents: 990 }] }],
    });
    expect(pattern(rule(spec), context)).toEqual([]);
  });

  describe("valueRange is inclusive on both ends (deliberate decision)", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA", valueRange: [500, 1000] };

    it("matches an item priced at exactly the lower bound", () => {
      const context = ctx({ sections: [{ name: "S", items: [{ description: "SVA", amountCents: 500 }] }] });
      expect(pattern(rule(spec), context)).toHaveLength(1);
    });

    it("matches an item priced at exactly the upper bound", () => {
      const context = ctx({ sections: [{ name: "S", items: [{ description: "SVA", amountCents: 1000 }] }] });
      expect(pattern(rule(spec), context)).toHaveLength(1);
    });

    it("excludes an item one cent below the lower bound", () => {
      const context = ctx({ sections: [{ name: "S", items: [{ description: "SVA", amountCents: 499 }] }] });
      expect(pattern(rule(spec), context)).toEqual([]);
    });

    it("excludes an item one cent above the upper bound", () => {
      const context = ctx({ sections: [{ name: "S", items: [{ description: "SVA", amountCents: 1001 }] }] });
      expect(pattern(rule(spec), context)).toEqual([]);
    });
  });

  describe("requireRecurrence", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA", requireRecurrence: 1 };
    const invoiceWithSva = {
      issuer: { name: "Claro Móvel", category: "telecom" as const },
      period: { start: "2026-06-01", end: "2026-06-30" },
      dueDate: "2026-07-10",
      totalCents: 990,
      sections: [{ name: "Serviços digitais", items: [{ description: "SVA Turbo", amountCents: 990 }] }],
      extraction: { confidence: 0.9, warnings: [] },
    } satisfies InvoiceCanonical;

    it("produces nothing with no previous invoice, rather than assuming recurrence", () => {
      const context = ctx(
        { sections: [{ name: "Serviços digitais", items: [{ description: "SVA Turbo", amountCents: 990 }] }] },
        null,
      );
      expect(pattern(rule(spec), context)).toEqual([]);
    });

    it("fires when the same normalised description also appears on the previous invoice", () => {
      const context = ctx(
        { sections: [{ name: "Serviços digitais", items: [{ description: "SVA Turbo", amountCents: 990 }] }] },
        invoiceWithSva,
      );
      expect(pattern(rule(spec), context)).toHaveLength(1);
    });

    it("does not fire when the previous invoice exists but lacks the item", () => {
      const context = ctx(
        { sections: [{ name: "Serviços digitais", items: [{ description: "SVA Turbo", amountCents: 990 }] }] },
        { ...invoiceWithSva, sections: [{ name: "Serviços digitais", items: [{ description: "Plano", amountCents: 990 }] }] },
      );
      expect(pattern(rule(spec), context)).toEqual([]);
    });
  });

  it("sets doubledCents from the rule's own legalBasis (effect 'dobro'), never guessing", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA" };
    const context = ctx({ sections: [{ name: "S", items: [{ description: "SVA", amountCents: 990 }] }] });

    const withDobro = pattern(rule(spec, { legalBasis: [{ law: "CDC", article: "42", effect: "dobro" }] }), context);
    expect(withDobro[0]?.doubledCents).toBe(1980);

    const withoutDobro = pattern(rule(spec, { legalBasis: [{ law: "CDC", article: "39", effect: "limite" }] }), context);
    expect(withoutDobro[0]?.doubledCents).toBeNull();
  });

  it("produces one finding per matching item across multiple sections", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA" };
    const context = ctx({
      sections: [
        { name: "A", items: [{ description: "SVA 1", amountCents: 100 }] },
        { name: "B", items: [{ description: "SVA 2", amountCents: 200 }] },
      ],
    });
    expect(pattern(rule(spec), context)).toHaveLength(2);
  });

  it("formats a negative amount (a credit line item) with a leading minus sign", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA" };
    const context = ctx({
      sections: [{ name: "S", items: [{ description: "SVA estorno", amountCents: -1234567 }] }],
    });
    const [finding] = pattern(rule(spec), context);
    expect(finding?.evidence[0]).toContain("-R$ 12.345,67");
  });

  it("throws when routed a rule of the wrong kind - a routing bug, not a data problem", () => {
    const spec: RuleSpec = { kind: "threshold", expr: "total", operator: ">", value: 0 };
    const context = ctx({});
    expect(() => pattern(rule(spec), context)).toThrow();
  });

  it("rejects a catastrophically-backtracking spec.match before ever running it (see safe-regex.test.ts)", () => {
    const spec: RuleSpec = { kind: "pattern", match: "(A+)+" };
    expect(() => pattern(rule(spec), ctx({}))).toThrow(/backtrack/i);
  });

  it("rejects a catastrophically-backtracking spec.notMatch the same way", () => {
    const spec: RuleSpec = { kind: "pattern", match: "SVA", notMatch: "(A+)+" };
    expect(() => pattern(rule(spec), ctx({}))).toThrow(/backtrack/i);
  });
});
