import { describe, expect, it } from "vitest";
import { runRules } from "./engine.js";
import type { ActiveRule, RuleEngineInput } from "./engine.js";
import type { InvoiceCanonical } from "../invoice/canonical.js";
import type { LegalRef } from "./spec.js";

const noReferences = { tariffs: [], flags: [] };

const LEGAL: LegalRef = { law: "CDC", article: "art. 39, III, p.u.", effect: "vedada" };

function invoiceWith(
  sections: InvoiceCanonical["sections"],
  overrides: Partial<InvoiceCanonical> = {},
): InvoiceCanonical {
  return {
    issuer: { name: "Claro Móvel", category: "telecom" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: sections.flatMap((s) => s.items).reduce((sum, i) => sum + i.amountCents, 0),
    sections,
    extraction: { confidence: 0.9, warnings: [] },
    ...overrides,
  };
}

function baseRule(overrides: Partial<ActiveRule> = {}): ActiveRule {
  return {
    slug: "regra-teste",
    version: 1,
    spec: { kind: "threshold", expr: "total", operator: ">", value: 0 },
    confidenceBase: 0.9,
    shadow: false,
    legalBasis: [LEGAL],
    issuerId: null,
    ...overrides,
  };
}

function run(partial: { invoice: InvoiceCanonical; rules: ActiveRule[] } & Partial<RuleEngineInput>) {
  return runRules({ previous: null, answers: {}, references: noReferences, ...partial });
}

describe("RF-120: purity, determinism, no mutation", () => {
  it("returns no findings when no rule is active", () => {
    const invoice = invoiceWith([{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }]);
    expect(run({ invoice, rules: [] })).toEqual([]);
  });

  it("is pure: repeated calls with the same non-empty input yield an identical result", () => {
    const invoice = invoiceWith([
      {
        name: "Serviços Digitais",
        items: [
          { description: "SVA Turbo", amountCents: 990 },
          { description: "SVA Cinema", amountCents: 990 },
          { description: "SVA Musica", amountCents: 990 },
        ],
      },
    ]);
    const rules: ActiveRule[] = [
      baseRule({
        slug: "rn-020-sva",
        spec: { kind: "pattern", sections: ["Serviços Digitais"], match: "SVA" },
        confidenceBase: 0.8,
      }),
    ];
    const input: RuleEngineInput = { invoice, previous: null, rules, answers: {}, references: noReferences };

    expect(runRules(input)).toEqual(runRules(input));
  });

  it("does not mutate the invoice, the previous invoice, the rules, or the references it is given", () => {
    const invoice = invoiceWith([
      { name: "Serviços Digitais", items: [{ description: "SVA Turbo", amountCents: 990 }] },
    ]);
    const previous = invoiceWith([
      { name: "Serviços Digitais", items: [{ description: "Outro item", amountCents: 500 }] },
    ]);
    const rules: ActiveRule[] = [baseRule({ spec: { kind: "pattern", match: "SVA" } })];
    const references = { tariffs: [], flags: [] };

    const invoiceSnapshot = JSON.stringify(invoice);
    const previousSnapshot = JSON.stringify(previous);
    const rulesSnapshot = JSON.stringify(rules);
    const referencesSnapshot = JSON.stringify(references);

    runRules({ invoice, previous, rules, answers: {}, references });

    expect(JSON.stringify(invoice)).toBe(invoiceSnapshot);
    expect(JSON.stringify(previous)).toBe(previousSnapshot);
    expect(JSON.stringify(rules)).toBe(rulesSnapshot);
    expect(JSON.stringify(references)).toBe(referencesSnapshot);
  });
});

describe("RF-123: issuer-specific precedence", () => {
  const invoice = invoiceWith([
    { name: "Fatura", items: [{ description: "Tarifa de Renovação de Cadastro", amountCents: 1590 }] },
  ]);

  it("creates only the issuer-specific finding when a generic and a specific rule share a slug", () => {
    const generic = baseRule({
      slug: "rn-008-renovacao",
      spec: { kind: "pattern", match: "RENOVACAO (DE )?CADASTRO" },
      confidenceBase: 0.9,
      legalBasis: [LEGAL],
      issuerId: null,
    });
    const specific = baseRule({
      slug: "rn-008-renovacao",
      spec: { kind: "pattern", match: "RENOVACAO (DE )?CADASTRO" },
      confidenceBase: 0.99,
      legalBasis: [{ law: "Circular BCB 3.466/2009", article: "vedação à renovação", effect: "vedada" }],
      issuerId: "issuer-itau",
    });

    const findings = run({ invoice, rules: [generic, specific] });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidence).toBe(0.99);
    expect(findings[0]?.legalBasis[0]?.law).toBe("Circular BCB 3.466/2009");
  });

  it("keeps the generic rule's finding when no issuer-specific override exists for that slug", () => {
    const generic = baseRule({
      slug: "rn-008-renovacao",
      spec: { kind: "pattern", match: "RENOVACAO (DE )?CADASTRO" },
    });
    expect(run({ invoice, rules: [generic] })).toHaveLength(1);
  });
});

describe("suppressor phase (§12.4) — powered by Task 3's real evaluators/suppressor.ts", () => {
  it("removes a finding whose own evidence text matches an active suppressor rule's blocks", () => {
    const invoice = invoiceWith([{ name: "Fatura", items: [{ description: "ICMS sobre TUSD", amountCents: 500 }] }]);
    // `some-icms-rule` names nothing about ICMS/TUSD in its slug on purpose —
    // suppressor.ts matches evidence text, never ruleSlug (INV-010 must
    // catch a dead thesis even under an unrelated-looking slug).
    const flagged = baseRule({ slug: "some-icms-rule", spec: { kind: "pattern", match: "ICMS" } });
    const suppressorRule = baseRule({
      slug: "rn-090-suppressor",
      spec: { kind: "suppressor", blocks: ["(?=.*ICMS)(?=.*TUSD)"], reason: "STJ Tema 986" },
    });

    expect(run({ invoice, rules: [flagged, suppressorRule] })).toEqual([]);
  });

  it("leaves findings alone when no suppressor rule's pattern matches their evidence", () => {
    const invoice = invoiceWith([{ name: "Fatura", items: [{ description: "ICMS sobre TUSD", amountCents: 500 }] }]);
    const flagged = baseRule({ slug: "some-icms-rule", spec: { kind: "pattern", match: "ICMS" } });
    const suppressorRule = baseRule({
      slug: "rn-090-suppressor",
      spec: { kind: "suppressor", blocks: ["COSIP"], reason: "STJ Tema 986" },
    });

    expect(run({ invoice, rules: [flagged, suppressorRule] })).toHaveLength(1);
  });

  it("never routes a suppressor-kind rule to the other six evaluators (they throw on the wrong kind)", () => {
    const invoice = invoiceWith([{ name: "Fatura", items: [{ description: "Qualquer coisa", amountCents: 100 }] }]);
    const suppressorRule = baseRule({
      slug: "rn-091",
      spec: { kind: "suppressor", blocks: ["NONEXISTENT"], reason: "x" },
    });
    expect(() => run({ invoice, rules: [suppressorRule] })).not.toThrow();
    expect(run({ invoice, rules: [suppressorRule] })).toEqual([]);
  });
});

describe("RF-124: confidence thresholds", () => {
  const invoice = invoiceWith([{ name: "Fatura", items: [{ description: "Encargo suspeito", amountCents: 100 }] }]);

  it("below 0.55 becomes a question, not a visible finding (PRD's own 0.5 example)", () => {
    const rule = baseRule({ spec: { kind: "pattern", match: "ENCARGO" }, confidenceBase: 0.5 });
    const [finding] = run({ invoice, rules: [rule] });
    expect(finding?.askUser).toBeDefined();
    expect(finding?.askUser?.question).toBe("Esta cobrança está correta?");
    expect(finding?.askUser?.options).toEqual(["Sim", "Não"]);
  });

  it("exactly 0.55 is visible, not a question — PRD phrases the low cut as strict '< 0,55'", () => {
    const rule = baseRule({ spec: { kind: "pattern", match: "ENCARGO" }, confidenceBase: 0.55 });
    const [finding] = run({ invoice, rules: [rule] });
    expect(finding?.askUser).toBeUndefined();
  });

  it("0.8 and just above it are both visible — the 0.8 cut only changes the display label (E3), not the finding shape", () => {
    const atBoundary = baseRule({ spec: { kind: "pattern", match: "ENCARGO" }, confidenceBase: 0.8 });
    const aboveBoundary = baseRule({ spec: { kind: "pattern", match: "ENCARGO" }, confidenceBase: 0.81 });
    expect(run({ invoice, rules: [atBoundary] })[0]?.askUser).toBeUndefined();
    expect(run({ invoice, rules: [aboveBoundary] })[0]?.askUser).toBeUndefined();
  });

  it("leaves an already-question finding (from `confirm`) untouched regardless of its confidence", () => {
    const rule = baseRule({
      spec: {
        kind: "confirm",
        question: "Você reconhece esta assinatura?",
        options: ["Sim", "Não"],
        onNo: "create_finding",
      },
      confidenceBase: 0.5,
    });
    const [finding] = run({ invoice, rules: [rule] });
    expect(finding?.askUser?.question).toBe("Você reconhece esta assinatura?");
  });
});

describe("RF-128 / RN-022: clustering", () => {
  function svaInvoice(count: number, sectionName = "Serviços Digitais") {
    const letters = "ABCDEFGH".slice(0, count).split("");
    return invoiceWith([
      {
        name: sectionName,
        items: letters.map((letter) => ({ description: `SVA ${letter}`, amountCents: 1032 })),
      },
    ]);
  }

  it('aggregates 3+ same-section pattern findings into one finding shown first — "R$ 51,60 em 5 serviços digitais"', () => {
    const invoice = svaInvoice(5);
    const rule = baseRule({
      slug: "rn-020-sva",
      spec: { kind: "pattern", sections: ["Serviços Digitais"], match: "SVA" },
      confidenceBase: 0.8,
      legalBasis: [{ law: "CDC", article: "art. 39, III, p.u.", effect: "dobro" }],
    });

    const findings = run({ invoice, rules: [rule] });

    expect(findings).toHaveLength(6); // 1 aggregate + 5 individual
    const [aggregate, ...individual] = findings;
    expect(aggregate?.ruleSlug).toBe("cluster:Serviços Digitais");
    expect(aggregate?.evidence[0]).toContain("R$ 51,60 em 5 serviços digitais");
    expect(aggregate?.amountCents).toBe(5160);
    expect(aggregate?.doubledCents).toBe(10320); // every member's legalBasis is "dobro"
    expect(aggregate?.confidence).toBe(0.8);
    expect(aggregate?.legalBasis).toHaveLength(1); // 5 identical legalBasis entries dedupe to 1
    expect(individual).toHaveLength(5);
  });

  it("does not aggregate when there are only 2 matches", () => {
    const invoice = svaInvoice(2);
    const rule = baseRule({ spec: { kind: "pattern", sections: ["Serviços Digitais"], match: "SVA" } });
    const findings = run({ invoice, rules: [rule] });
    expect(findings.every((f) => !f.ruleSlug.startsWith("cluster:"))).toBe(true);
    expect(findings).toHaveLength(2);
  });

  it("never clusters a pattern rule with no declared section at all (ambiguous scope)", () => {
    const invoice = svaInvoice(3, "Qualquer Seção");
    const rule = baseRule({ spec: { kind: "pattern", match: "SVA" } }); // no `sections` restriction
    const findings = run({ invoice, rules: [rule] });
    expect(findings.every((f) => !f.ruleSlug.startsWith("cluster:"))).toBe(true);
    expect(findings).toHaveLength(3);
  });

  it("never clusters a pattern rule whose declared sections are ambiguous (more than one)", () => {
    const invoice = svaInvoice(3, "Seção 1");
    const rule = baseRule({ spec: { kind: "pattern", sections: ["Seção 1", "Seção 2"], match: "SVA" } });
    const findings = run({ invoice, rules: [rule] });
    expect(findings.every((f) => !f.ruleSlug.startsWith("cluster:"))).toBe(true);
  });

  it("excludes a below-threshold (question) finding from clustering, even sharing a section with 2+ others", () => {
    const invoice = svaInvoice(3);
    const rule = baseRule({
      spec: { kind: "pattern", sections: ["Serviços Digitais"], match: "SVA" },
      confidenceBase: 0.5,
    });
    const findings = run({ invoice, rules: [rule] });
    expect(findings.every((f) => !f.ruleSlug.startsWith("cluster:"))).toBe(true);
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.askUser !== undefined)).toBe(true);
  });

  it("clusters shadow and non-shadow findings separately, never merging them into one aggregate", () => {
    const invoice = svaInvoice(3);
    const shadowRule = baseRule({
      slug: "rule-shadow",
      spec: { kind: "pattern", sections: ["Serviços Digitais"], match: "SVA" },
      shadow: true,
    });
    const liveRule = baseRule({
      slug: "rule-live",
      spec: { kind: "pattern", sections: ["Serviços Digitais"], match: "SVA" },
      shadow: false,
    });

    const findings = run({ invoice, rules: [shadowRule, liveRule] });
    const aggregates = findings.filter((f) => f.ruleSlug.startsWith("cluster:"));

    expect(aggregates).toHaveLength(2);
    expect(aggregates.every((a) => a.amountCents === 3096)).toBe(true);
    expect(aggregates.find((a) => a.shadow)).toBeDefined();
    expect(aggregates.find((a) => !a.shadow)).toBeDefined();
  });
});

describe("RF-129: reject findings without evidence or legal basis", () => {
  it("rejects a finding whose rule carries no legalBasis, without trying to repair it", () => {
    const invoice = invoiceWith([{ name: "Fatura", items: [{ description: "Encargo suspeito", amountCents: 100 }] }]);
    const rule = baseRule({ spec: { kind: "pattern", match: "ENCARGO" }, legalBasis: [] });
    expect(run({ invoice, rules: [rule] })).toEqual([]);
  });

  it("keeps a since-rejected member's amount inside an aggregate formed before RF-129 runs — the stated step order is literal, on purpose", () => {
    const invoice = invoiceWith([
      {
        name: "Serviços Digitais",
        items: [
          { description: "SVA A especial", amountCents: 100 },
          { description: "SVA B especial", amountCents: 100 },
          { description: "SVA C especial", amountCents: 100 },
        ],
      },
    ]);
    const ruleFor = (letter: string, legalBasis: LegalRef[]) =>
      baseRule({
        slug: `sva-${letter.toLowerCase()}`,
        spec: { kind: "pattern", sections: ["Serviços Digitais"], match: `SVA ${letter} ESPECIAL` },
        legalBasis,
      });
    const rules = [ruleFor("A", [LEGAL]), ruleFor("B", [LEGAL]), ruleFor("C", [])];

    const findings = run({ invoice, rules });

    const aggregate = findings.find((f) => f.ruleSlug.startsWith("cluster:"));
    expect(aggregate?.amountCents).toBe(300); // includes sva-c's 100 cents
    expect(aggregate?.doubledCents).toBeNull(); // no member's legalBasis has effect "dobro"
    expect(findings.some((f) => f.ruleSlug === "sva-c")).toBe(false); // ...but its own finding was rejected
    expect(findings.filter((f) => f.ruleSlug === "sva-a" || f.ruleSlug === "sva-b")).toHaveLength(2);
  });
});

describe("evaluator dispatch", () => {
  it("dispatches a threshold-kind rule to the threshold evaluator", () => {
    const invoice = invoiceWith([{ name: "Fatura", items: [{ description: "Item", amountCents: 12345 }] }]);
    const rule = baseRule({ spec: { kind: "threshold", expr: "total", operator: ">", value: 0 } });
    const findings = run({ invoice, rules: [rule] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(12345);
  });
});
