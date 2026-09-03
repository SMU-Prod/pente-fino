import { describe, expect, it } from "vitest";
import { validateRuleDraft, type RuleDraftInput } from "./draft.js";
import type { LegalRef, RuleSpec } from "./spec.js";

const VALID_PATTERN_DRAFT: RuleDraftInput = {
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

const VALID_DELTA_DRAFT: RuleDraftInput = {
  slug: "delta-recorrente-teste",
  category: "telecom",
  issuerId: null,
  kind: "delta",
  spec: { kind: "delta", field: "amount", comparedTo: "previous_invoice", changeAtLeastPct: 10 },
  legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
  confidenceBase: 0.7,
  author: "admin-teste",
  reason: "Regra de teste para o tipo delta.",
};

const VALID_THRESHOLD_DRAFT: RuleDraftInput = {
  slug: "threshold-recorrente-teste",
  category: "telecom",
  issuerId: null,
  kind: "threshold",
  spec: { kind: "threshold", expr: "total_amount", operator: ">", value: 100 },
  legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
  confidenceBase: 0.7,
  author: "admin-teste",
  reason: "Regra de teste para o tipo threshold.",
};

const VALID_REFERENCE_DRAFT: RuleDraftInput = {
  slug: "reference-recorrente-teste",
  category: "energy",
  issuerId: null,
  kind: "reference",
  spec: { kind: "reference", source: "aneel_tariff", tolerancePct: 5 },
  legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
  confidenceBase: 0.7,
  author: "admin-teste",
  reason: "Regra de teste para o tipo reference.",
};

const VALID_CONFIRM_DRAFT: RuleDraftInput = {
  slug: "confirm-recorrente-teste",
  category: "telecom",
  issuerId: null,
  kind: "confirm",
  spec: { kind: "confirm", question: "O valor cobrado bate com o contrato?", options: ["sim", "nao"], onNo: "create_finding" },
  legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
  confidenceBase: 0.7,
  author: "admin-teste",
  reason: "Regra de teste para o tipo confirm.",
};

const VALID_ARITHMETIC_DRAFT: RuleDraftInput = {
  slug: "arithmetic-recorrente-teste",
  category: "telecom",
  issuerId: null,
  kind: "arithmetic",
  spec: { kind: "arithmetic", formula: "base * aliquota", expect: "valor_total", tolerancePct: 1 },
  legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
  confidenceBase: 0.7,
  author: "admin-teste",
  reason: "Regra de teste para o tipo arithmetic.",
};

describe("validateRuleDraft: a fully valid draft", () => {
  it("returns ok: true for a valid pattern draft", () => {
    expect(validateRuleDraft(VALID_PATTERN_DRAFT)).toEqual({ ok: true });
  });

  it("returns ok: true for a valid suppressor draft with an empty legalBasis", () => {
    expect(validateRuleDraft(VALID_SUPPRESSOR_DRAFT)).toEqual({ ok: true });
  });

  it("returns ok: true for a valid delta draft", () => {
    expect(validateRuleDraft(VALID_DELTA_DRAFT)).toEqual({ ok: true });
  });

  it("returns ok: true for a valid threshold draft", () => {
    expect(validateRuleDraft(VALID_THRESHOLD_DRAFT)).toEqual({ ok: true });
  });

  it("returns ok: true for a valid reference draft", () => {
    expect(validateRuleDraft(VALID_REFERENCE_DRAFT)).toEqual({ ok: true });
  });

  it("returns ok: true for a valid confirm draft", () => {
    expect(validateRuleDraft(VALID_CONFIRM_DRAFT)).toEqual({ ok: true });
  });

  it("returns ok: true for a valid arithmetic draft", () => {
    expect(validateRuleDraft(VALID_ARITHMETIC_DRAFT)).toEqual({ ok: true });
  });
});

describe("validateRuleDraft: check 1 — slug shape", () => {
  it("rejects a slug with uppercase letters or invalid characters", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, slug: "Gasto_Ruim!" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "slug", code: "slug_invalid_format" }),
    );
  });

  it("rejects a slug shorter than 3 characters", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, slug: "ab" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "slug", code: "slug_invalid_length" }),
    );
  });

  it("rejects a slug longer than 64 characters", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, slug: "a".repeat(65) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "slug", code: "slug_invalid_length" }),
    );
  });
});

describe("validateRuleDraft: check 2 — kind must agree with spec.kind", () => {
  it("rejects a draft whose kind disagrees with spec.kind", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, kind: "threshold" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "kind", code: "kind_spec_mismatch" }),
    );
  });
});

describe("validateRuleDraft: check 3 — confidenceBase range", () => {
  it.each([0, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an out-of-range confidenceBase: %s",
    (confidenceBase) => {
      const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, confidenceBase });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.problems).toContainEqual(
        expect.objectContaining({ field: "confidenceBase", code: "confidence_base_out_of_range" }),
      );
    },
  );

  it("accepts confidenceBase at the inclusive upper bound of 1", () => {
    expect(validateRuleDraft({ ...VALID_PATTERN_DRAFT, confidenceBase: 1 })).toEqual({ ok: true });
  });
});

describe("validateRuleDraft: check 4 — author and reason", () => {
  it("rejects an empty (or whitespace-only) author", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, author: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(expect.objectContaining({ field: "author", code: "author_required" }));
  });

  it("rejects an empty (or whitespace-only) reason", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, reason: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(expect.objectContaining({ field: "reason", code: "reason_required" }));
  });

  it("rejects a reason longer than 500 characters", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, reason: "a".repeat(501) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(expect.objectContaining({ field: "reason", code: "reason_too_long" }));
  });
});

describe("validateRuleDraft: check 5 — spec structural validation per kind", () => {
  it("rejects a structurally-invalid pattern spec (missing match) without throwing", () => {
    let result: ReturnType<typeof validateRuleDraft> | undefined;
    expect(() => {
      result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, spec: { kind: "pattern" } as unknown as RuleSpec });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.match", code: "spec_match_required" }),
    );
    // A crash would come back as `unsafe_pattern` never even being reached —
    // this asserts the structural problem is there, not that `unsafe_pattern`
    // is absent (a bogus `match` should not be handed to `assertSafePattern`).
    expect(result.problems.some((p) => p.code === "unsafe_pattern")).toBe(false);
  });

  it("rejects a structurally-invalid delta spec", () => {
    const result = validateRuleDraft({ ...VALID_DELTA_DRAFT, spec: { kind: "delta" } as unknown as RuleSpec });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.field", code: "spec_field_invalid" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.comparedTo", code: "spec_comparedTo_invalid" }),
    );
  });

  it("rejects a structurally-invalid threshold spec", () => {
    const result = validateRuleDraft({ ...VALID_THRESHOLD_DRAFT, spec: { kind: "threshold" } as unknown as RuleSpec });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.expr", code: "spec_expr_required" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.operator", code: "spec_operator_invalid" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.value", code: "spec_value_invalid" }),
    );
  });

  it("rejects a structurally-invalid reference spec", () => {
    const result = validateRuleDraft({ ...VALID_REFERENCE_DRAFT, spec: { kind: "reference" } as unknown as RuleSpec });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.source", code: "spec_source_invalid" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.tolerancePct", code: "spec_tolerancePct_invalid" }),
    );
  });

  it("rejects a structurally-invalid confirm spec", () => {
    const result = validateRuleDraft({ ...VALID_CONFIRM_DRAFT, spec: { kind: "confirm" } as unknown as RuleSpec });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.question", code: "spec_question_required" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.options", code: "spec_options_invalid" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.onNo", code: "spec_onNo_invalid" }),
    );
  });

  it("rejects a structurally-invalid arithmetic spec", () => {
    const result = validateRuleDraft({
      ...VALID_ARITHMETIC_DRAFT,
      spec: { kind: "arithmetic" } as unknown as RuleSpec,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.formula", code: "spec_formula_required" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.expect", code: "spec_expect_required" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.tolerancePct", code: "spec_tolerancePct_invalid" }),
    );
  });

  it("rejects a structurally-invalid suppressor spec", () => {
    const result = validateRuleDraft({
      ...VALID_SUPPRESSOR_DRAFT,
      spec: { kind: "suppressor" } as unknown as RuleSpec,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.blocks", code: "spec_blocks_invalid" }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.reason", code: "spec_reason_required" }),
    );
  });
});

describe("validateRuleDraft: check 6 — assertSafePattern on spec.match/notMatch", () => {
  it("rejects a catastrophically-backtracking spec.match", () => {
    const result = validateRuleDraft({
      ...VALID_PATTERN_DRAFT,
      spec: { kind: "pattern", match: "(a+)+" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(expect.objectContaining({ field: "spec.match", code: "unsafe_pattern" }));
  });

  it("rejects a catastrophically-backtracking spec.notMatch", () => {
    const result = validateRuleDraft({
      ...VALID_PATTERN_DRAFT,
      spec: { kind: "pattern", match: "SVA", notMatch: "(a+)+" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "spec.notMatch", code: "unsafe_pattern" }),
    );
  });

  it("does not let UnsafePatternError escape — it comes back as a problem, not a thrown error", () => {
    expect(() =>
      validateRuleDraft({ ...VALID_PATTERN_DRAFT, spec: { kind: "pattern", match: "(a+)+" } }),
    ).not.toThrow();
  });

  it("accepts a safe pattern", () => {
    expect(
      validateRuleDraft({ ...VALID_PATTERN_DRAFT, spec: { kind: "pattern", match: "SVA|SEGURO" } }),
    ).toEqual({ ok: true });
  });
});

describe("validateRuleDraft: check 7 — INV-006 sensitive vocabulary", () => {
  it("rejects a spec.match carrying a sensitive-category term", () => {
    const result = validateRuleDraft({
      ...VALID_PATTERN_DRAFT,
      spec: { kind: "pattern", match: "farmacia|drogaria" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const problem = result.problems.find((p) => p.code === "sensitive_term");
    expect(problem).toBeDefined();
    expect(problem?.message).toContain("farmac");
  });

  it("rejects a sensitive term hidden in the slug", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, slug: "gasto-igreja-mensal" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(expect.objectContaining({ code: "sensitive_term" }));
  });

  it("does not scan author for sensitive terms", () => {
    // "Igreja" would be a hit anywhere else this function scans; it must not
    // be flagged when it only ever appears in `author`, a person's name.
    expect(
      validateRuleDraft({ ...VALID_PATTERN_DRAFT, author: "Maria Igreja Batista" }),
    ).toEqual({ ok: true });
  });

  it("accepts a clean spec with no sensitive vocabulary", () => {
    expect(
      validateRuleDraft({ ...VALID_PATTERN_DRAFT, spec: { kind: "pattern", match: "cobranca duplicada" } }),
    ).toEqual({ ok: true });
  });
});

describe("validateRuleDraft: check 8 — RF-129 legalBasis, exempting suppressor", () => {
  it("rejects an empty legalBasis for a non-suppressor kind", () => {
    const result = validateRuleDraft({ ...VALID_PATTERN_DRAFT, legalBasis: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "legalBasis", code: "legal_basis_required" }),
    );
  });

  it("does not require legalBasis for a suppressor", () => {
    expect(validateRuleDraft(VALID_SUPPRESSOR_DRAFT)).toEqual({ ok: true });
  });
});

describe("validateRuleDraft: check 9 — LegalRef structural validation", () => {
  it("rejects an invalid LegalRef.effect", () => {
    const result = validateRuleDraft({
      ...VALID_PATTERN_DRAFT,
      legalBasis: [{ law: "CDC", article: "39", effect: "invalido" as unknown as LegalRef["effect"] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "legalBasis[0].effect", code: "legal_basis_effect_invalid" }),
    );
  });

  it("rejects an empty law", () => {
    const result = validateRuleDraft({
      ...VALID_PATTERN_DRAFT,
      legalBasis: [{ law: "", article: "39", effect: "dobro" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "legalBasis[0].law", code: "legal_basis_law_required" }),
    );
  });

  it("rejects an empty article", () => {
    const result = validateRuleDraft({
      ...VALID_PATTERN_DRAFT,
      legalBasis: [{ law: "CDC", article: "", effect: "dobro" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: "legalBasis[0].article", code: "legal_basis_article_required" }),
    );
  });

  it("accepts every declared LegalRef.effect literal", () => {
    const effects: LegalRef["effect"][] = [
      "dobro", "suspensao", "cancelamento", "amostra_gratis", "vedada", "limite",
    ];
    for (const effect of effects) {
      const result = validateRuleDraft({
        ...VALID_PATTERN_DRAFT,
        legalBasis: [{ law: "CDC", article: "39", effect }],
      });
      expect(result).toEqual({ ok: true });
    }
  });
});

describe("validateRuleDraft: collects every problem, not just the first", () => {
  it("returns problems for several independently-broken fields at once", () => {
    const result = validateRuleDraft({
      ...VALID_PATTERN_DRAFT,
      slug: "Invalido!",
      confidenceBase: 0,
      author: "",
      spec: { kind: "pattern", match: "(a+)+" },
      legalBasis: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const codes = result.problems.map((p) => p.code).sort();
    expect(codes).toEqual(
      [
        "author_required",
        "confidence_base_out_of_range",
        "legal_basis_required",
        "slug_invalid_format",
        "unsafe_pattern",
      ].sort(),
    );
  });
});
