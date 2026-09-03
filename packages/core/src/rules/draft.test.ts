import { describe, expect, it } from "vitest";
import { validateRuleDraft, type RuleDraftInput } from "./draft.js";

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

describe("validateRuleDraft: a fully valid draft", () => {
  it("returns ok: true for a valid pattern draft", () => {
    expect(validateRuleDraft(VALID_PATTERN_DRAFT)).toEqual({ ok: true });
  });

  it("returns ok: true for a valid suppressor draft with an empty legalBasis", () => {
    expect(validateRuleDraft(VALID_SUPPRESSOR_DRAFT)).toEqual({ ok: true });
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

describe("validateRuleDraft: check 5 — assertSafePattern on spec.match/notMatch", () => {
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

describe("validateRuleDraft: check 6 — INV-006 sensitive vocabulary", () => {
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

describe("validateRuleDraft: check 7 — RF-129 legalBasis, exempting suppressor", () => {
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
