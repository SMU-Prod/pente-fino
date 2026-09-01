import { describe, expect, it } from "vitest";
import { confirm, confirmAnswerKey } from "./index.js";
import type { ActiveRule } from "../engine.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";
import type { EvaluationContext } from "./types.js";

const noReferences = { tariffs: [], flags: [] };

const invoice: InvoiceCanonical = {
  issuer: { name: "Banco Exemplo", category: "card" },
  period: { start: "2026-08-01", end: "2026-08-31" },
  dueDate: "2026-09-10",
  totalCents: 10000,
  sections: [{ name: "Encargos", items: [{ description: "Seguro Proteção", amountCents: 1200 }] }],
  extraction: { confidence: 0.9, warnings: [] },
} as InvoiceCanonical;

function confirmRule(): ActiveRule {
  return {
    slug: "rn-021",
    version: 1,
    spec: {
      kind: "confirm",
      question: "Esta cobrança de seguro está correta?",
      options: ["Sim", "Não"],
      onNo: "create_finding",
    },
    confidenceBase: 0.72,
    shadow: false,
    legalBasis: [{ law: "CDC", article: "39", effect: "vedada" }],
    issuerId: null,
  };
}

function ctx(answers: Record<string, string>): EvaluationContext {
  return { invoice, previous: null, references: noReferences, answers };
}

describe("confirm - guards", () => {
  it("returns nothing when called with a rule of a different kind (defensive dispatch guard)", () => {
    const notConfirm: ActiveRule = {
      slug: "not-confirm",
      version: 1,
      spec: { kind: "threshold", expr: "total", operator: ">", value: 0 },
      confidenceBase: 0.5,
      shadow: false,
      legalBasis: [{ law: "CDC", article: "39", effect: "vedada" }],
      issuerId: null,
    };
    expect(confirm(notConfirm, ctx({}))).toEqual([]);
  });
});

describe("confirm - unanswered", () => {
  it("asks the question instead of accusing, when no answer is recorded (positive)", () => {
    const rule = confirmRule();
    const findings = confirm(rule, ctx({}));
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.askUser).toEqual({
      question: "Esta cobrança de seguro está correta?",
      options: ["Sim", "Não"],
    });
    expect(finding?.amountCents).toBe(0);
    expect(finding?.doubledCents).toBeNull();
    expect(finding?.evidence.length).toBeGreaterThan(0);
    expect(finding?.legalBasis).toBe(rule.legalBasis);
    expect(finding?.ruleSlug).toBe(rule.slug);
    expect(finding?.confidence).toBe(rule.confidenceBase);
  });
});

describe("confirm - answered", () => {
  it('creates a finding when the recorded answer is a decline ("Não") per spec.onNo', () => {
    const rule = confirmRule();
    const key = confirmAnswerKey(rule, null);
    const findings = confirm(rule, ctx({ [key]: "Não" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.askUser).toBeUndefined();
    expect(findings[0]?.evidence.length).toBeGreaterThan(0);
    expect(findings[0]?.legalBasis).toBe(rule.legalBasis);
  });

  it('does not create a finding when the recorded answer confirms the charge ("Sim") (negative)', () => {
    const rule = confirmRule();
    const key = confirmAnswerKey(rule, null);
    expect(confirm(rule, ctx({ [key]: "Sim" }))).toEqual([]);
  });

  it("recognises a decline case- and accent-insensitively", () => {
    const rule = confirmRule();
    const key = confirmAnswerKey(rule, null);
    expect(confirm(rule, ctx({ [key]: "nao" }))).toHaveLength(1);
    expect(confirm(rule, ctx({ [key]: "NÃO" }))).toHaveLength(1);
  });
});

describe("confirm - answer keying", () => {
  it("keys an answer by rule slug + version + item, so the same rule on two items cannot collide", () => {
    const rule = confirmRule();
    const keyForItemA = confirmAnswerKey(rule, "item_a");
    const keyForItemB = confirmAnswerKey(rule, "item_b");
    expect(keyForItemA).not.toBe(keyForItemB);

    const otherVersion: ActiveRule = { ...rule, version: 2 };
    expect(confirmAnswerKey(otherVersion, "item_a")).not.toBe(keyForItemA);
  });

  it("falls back to an invoice-level key when there is no item to scope the question to", () => {
    const rule = confirmRule();
    expect(confirmAnswerKey(rule, null)).toBe(`${rule.slug}@${rule.version}:invoice`);
  });

  it("an answer recorded under a different rule's key does not affect this rule (no collision across rules)", () => {
    const rule = confirmRule();
    const otherRule: ActiveRule = { ...rule, slug: "rn-024" };
    const answers = { [confirmAnswerKey(otherRule, null)]: "Não" };
    expect(confirm(rule, ctx(answers))).toHaveLength(1); // still unanswered for `rule`, so it asks
    expect(confirm(rule, ctx(answers))[0]?.askUser).toBeDefined();
  });
});
