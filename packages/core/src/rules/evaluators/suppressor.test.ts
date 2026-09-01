import { describe, expect, it } from "vitest";
import { applySuppressors, suppressor } from "./suppressor.js";
import { pattern } from "./pattern.js";
import type { ActiveRule } from "../engine.js";
import type { Finding } from "../finding.js";
import type { RuleSpec } from "../spec.js";
import type { EvaluationContext } from "./types.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";

function rule(spec: RuleSpec, overrides: Partial<ActiveRule> = {}): ActiveRule {
  return {
    slug: "rn-090-icms-tusd-tust",
    version: 1,
    spec,
    confidenceBase: 1,
    shadow: false,
    legalBasis: [],
    issuerId: null,
    category: "energy",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleSlug: "sva-nao-contratado",
    ruleVersion: 1,
    itemId: null,
    amountCents: 990,
    doubledCents: null,
    confidence: 0.8,
    evidence: ["Serviço de valor adicionado — R$ 9,90 para você verificar."],
    legalBasis: [{ law: "CDC", article: "39 III p.u.", effect: "limite" }],
    shadow: false,
    ...overrides,
  };
}

function ctx(invoice: Partial<InvoiceCanonical>): EvaluationContext {
  return {
    invoice: {
      issuer: { name: "Enel SP", category: "energy" },
      period: { start: "2026-07-01", end: "2026-07-31" },
      dueDate: "2026-08-10",
      totalCents: 10000,
      sections: [{ name: "Fatura", items: [{ description: "Consumo", amountCents: 10000 }] }],
      extraction: { confidence: 0.9, warnings: [] },
      ...invoice,
    } as InvoiceCanonical,
    previous: null,
    references: { tariffs: [], flags: [] },
    answers: {},
  };
}

describe("suppressor evaluator", () => {
  it("removes a finding whose evidence matches spec.blocks (positive, RF-121)", () => {
    const spec: RuleSpec = { kind: "suppressor", blocks: ["ICMS"], reason: "Tese morta (STJ Tema 986)." };
    const target = finding({ evidence: ["ICMS sobre TUSD/TUST — R$ 12,34 para você verificar."] });
    const result = suppressor(rule(spec), [target]);
    expect(result.survivors).toEqual([]);
  });

  it("leaves untouched a finding that does not match any block pattern (negative, RF-121)", () => {
    const spec: RuleSpec = { kind: "suppressor", blocks: ["ICMS"], reason: "Tese morta (STJ Tema 986)." };
    const target = finding({ evidence: ["Multa por atraso — R$ 5,00 para você verificar."] });
    const result = suppressor(rule(spec), [target]);
    expect(result.survivors).toEqual([target]);
    expect(result.suppressed).toEqual([]);
  });

  it("records what it removes with the suppressor's slug, version and reason", () => {
    const spec: RuleSpec = { kind: "suppressor", blocks: ["ICMS"], reason: "Tese morta (STJ Tema 986)." };
    const target = finding({ evidence: ["ICMS sobre TUSD — R$ 12,34 para você verificar."] });
    const result = suppressor(rule(spec, { slug: "rn-090-icms-tusd-tust", version: 2 }), [target]);
    expect(result.suppressed).toEqual([
      { finding: target, ruleSlug: "rn-090-icms-tusd-tust", ruleVersion: 2, reason: "Tese morta (STJ Tema 986)." },
    ]);
  });

  it("matches case- and accent-insensitively via normalizeDescription (RF-122)", () => {
    const spec: RuleSpec = { kind: "suppressor", blocks: ["ICMS"], reason: "x" };
    const target = finding({ evidence: ["Icms cobrado indevidamente, segundo a fatura."] });
    expect(suppressor(rule(spec), [target]).survivors).toEqual([]);
  });

  it("matches against any of several block patterns", () => {
    const spec: RuleSpec = { kind: "suppressor", blocks: ["COSIP.*POSTE", "COSIP.*ILUMINACAO"], reason: "x" };
    const a = finding({ evidence: ["COSIP cobrado mesmo sem poste no logradouro."] });
    const b = finding({ evidence: ["COSIP cobrado mesmo sem iluminação pública."] });
    const c = finding({ evidence: ["Consumo de energia acima do normal."] });
    const result = suppressor(rule(spec), [a, b, c]);
    expect(result.survivors).toEqual([c]);
    expect(result.suppressed.map((s) => s.finding)).toEqual([a, b]);
  });

  it("only removes the matching findings out of a mixed list, preserving order of survivors", () => {
    const spec: RuleSpec = { kind: "suppressor", blocks: ["ICMS"], reason: "x" };
    const a = finding({ ruleSlug: "a", evidence: ["Item comum — para você verificar."] });
    const b = finding({ ruleSlug: "b", evidence: ["ICMS sobre TUSD — para você verificar."] });
    const c = finding({ ruleSlug: "c", evidence: ["Outro item comum — para você verificar."] });
    const result = suppressor(rule(spec), [a, b, c]);
    expect(result.survivors).toEqual([a, c]);
  });

  it("throws when routed a non-suppressor rule", () => {
    const spec: RuleSpec = { kind: "pattern", match: "X" };
    expect(() => suppressor(rule(spec), [])).toThrow(/suppressor evaluator received a "pattern" rule/);
  });

  it("is inert with an empty findings list", () => {
    const spec: RuleSpec = { kind: "suppressor", blocks: ["ICMS"], reason: "x" };
    expect(suppressor(rule(spec), [])).toEqual({ survivors: [], suppressed: [] });
  });

  // The whole point of INV-010: a rule that flags the same dead thesis under
  // a slug that names nothing about it must still be caught. This uses the
  // real `pattern` evaluator (Task 1, already shipped) to produce the
  // finding - not a hand-built Finding object - so the proof exercises the
  // same evidence-construction code a real rogue rule would.
  it("suppresses a finding produced by an unrelated-slug rule (INV-010's own claim)", () => {
    const rogue = rule(
      { kind: "pattern", match: "ICMS" },
      { slug: "energia-encargo-nao-identificado", version: 1 },
    );
    const context = ctx({
      sections: [{ name: "Fatura", items: [{ description: "ICMS sobre TUSD/TUST", amountCents: 4321 }] }],
    });
    const rogueFindings = pattern(rogue, context);
    expect(rogueFindings).toHaveLength(1); // sanity: the scenario is meaningful before suppression

    const suppressorRule = rule(
      { kind: "suppressor", blocks: ["(?=.*ICMS)(?=.*TUSD)", "(?=.*ICMS)(?=.*TUST)"], reason: "STJ Tema 986." },
      { slug: "rn-090-icms-tusd-tust", version: 1 },
    );
    const result = suppressor(suppressorRule, rogueFindings);
    expect(result.survivors).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.finding.ruleSlug).toBe("energia-encargo-nao-identificado");
  });
});

describe("applySuppressors", () => {
  it("runs multiple suppressor rules over the same findings, accumulating removals", () => {
    const icms = finding({ ruleSlug: "a", evidence: ["ICMS sobre TUSD — para você verificar."] });
    const cosip = finding({ ruleSlug: "b", evidence: ["COSIP sem poste — para você verificar."] });
    const clean = finding({ ruleSlug: "c", evidence: ["Item comum — para você verificar."] });

    const rn090 = rule(
      { kind: "suppressor", blocks: ["(?=.*ICMS)(?=.*TUSD)"], reason: "STJ Tema 986." },
      { slug: "rn-090-icms-tusd-tust" },
    );
    const rn091 = rule(
      { kind: "suppressor", blocks: ["COSIP.*POSTE"], reason: "Precedente COSIP." },
      { slug: "rn-091-cosip-sem-poste" },
    );

    const result = applySuppressors([rn090, rn091], [icms, cosip, clean]);
    expect(result.survivors).toEqual([clean]);
    expect(result.suppressed).toHaveLength(2);
    expect(result.suppressed.map((s) => s.ruleSlug).sort()).toEqual(["rn-090-icms-tusd-tust", "rn-091-cosip-sem-poste"]);
  });

  it("returns every finding untouched, and no suppressions, when there are no suppressor rules", () => {
    const clean = finding();
    expect(applySuppressors([], [clean])).toEqual({ survivors: [clean], suppressed: [] });
  });

  it("throws if one of the given rules is not a suppressor", () => {
    const notASuppressor = rule({ kind: "pattern", match: "X" });
    expect(() => applySuppressors([notASuppressor], [])).toThrow(/suppressor evaluator received a "pattern" rule/);
  });
});
