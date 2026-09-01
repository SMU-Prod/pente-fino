import { describe, expect, it } from "vitest";
import { evaluateExpression, ExpressionError, parseExpression } from "./expression.js";
import type { EvaluationContext } from "./types.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";

function ctxWith(overrides: Partial<InvoiceCanonical> = {}): EvaluationContext {
  const invoice = {
    issuer: { name: "Energia SA", category: "energy" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 10000,
    sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
    extraction: { confidence: 0.9, warnings: [] },
    ...overrides,
  } as InvoiceCanonical;
  return { invoice, previous: null, references: { tariffs: [], flags: [] }, answers: {} };
}

describe("parseExpression: structural validity (independent of any invoice)", () => {
  it("accepts a bare number", () => {
    expect(() => parseExpression("42")).not.toThrow();
  });

  it("accepts every allow-listed field name", () => {
    for (const name of [
      "total", "icms", "pis", "cofins", "te", "tusd",
      "readingsCurrent", "readingsPrevious", "kwh", "m3", "days",
    ]) {
      expect(() => parseExpression(name)).not.toThrow();
    }
  });

  it("rejects an unknown field name", () => {
    expect(() => parseExpression("bogus")).toThrow(ExpressionError);
    expect(() => parseExpression("bogus")).toThrow(/unknown field/);
  });

  it("rejects an unknown function name", () => {
    expect(() => parseExpression("wat(1, 2)")).toThrow(/unknown function/);
  });

  it("accepts the two aggregate functions with a quoted section name", () => {
    expect(() => parseExpression('sectionTotal("Serviços")')).not.toThrow();
    expect(() => parseExpression('sectionCount("Serviços")')).not.toThrow();
  });

  it("rejects sectionTotal/sectionCount given a non-string argument", () => {
    expect(() => parseExpression("sectionTotal(total)")).toThrow(/quoted section name/);
    expect(() => parseExpression("sectionCount(1)")).toThrow(/quoted section name/);
  });

  it("accepts max/min with two sub-expressions", () => {
    expect(() => parseExpression("max(1, 2)")).not.toThrow();
    expect(() => parseExpression("min(total, 2 * kwh)")).not.toThrow();
  });

  it("rejects max/min with the wrong arity", () => {
    expect(() => parseExpression("max(1)")).toThrow();
    expect(() => parseExpression("max(1, 2, 3)")).toThrow();
  });

  it("rejects an unterminated string literal", () => {
    expect(() => parseExpression('sectionTotal("Serviços')).toThrow(/unterminated string/);
  });

  it("rejects a malformed number", () => {
    expect(() => parseExpression("1.2.3")).toThrow(/invalid number/);
  });

  it("rejects an unexpected character", () => {
    expect(() => parseExpression("total & 1")).toThrow(/unexpected character/);
  });

  it("rejects trailing tokens after a complete expression", () => {
    expect(() => parseExpression("total total")).toThrow(/unexpected token/);
  });

  it("rejects a missing closing parenthesis", () => {
    expect(() => parseExpression("(total + 1")).toThrow();
  });

  it("rejects an empty expression", () => {
    expect(() => parseExpression("")).toThrow();
  });

  it("respects arithmetic precedence and parentheses", () => {
    const ctx = ctxWith();
    expect(evaluateExpression("2 + 3 * 4", ctx)).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", ctx)).toBe(20);
  });

  it("divides normally when the divisor is not zero", () => {
    expect(evaluateExpression("10 / 2", ctxWith())).toBe(5);
  });

  it("supports unary minus, including chained unary minus", () => {
    const ctx = ctxWith();
    expect(evaluateExpression("-5", ctx)).toBe(-5);
    expect(evaluateExpression("--5", ctx)).toBe(5);
  });
});

describe("evaluateExpression: field lookup against an invoice", () => {
  it("resolves every scalar field this language exposes", () => {
    const ctx = ctxWith({
      totalCents: 12345,
      tariffs: { teCentsKwh: 10, tusdCentsKwh: 20, pis: 0.0165, cofins: 0.076, icms: 0.18 },
      readings: { previous: 100, current: 150, kwh: 50, m3: 7, estimated: false, days: 30 },
    });
    expect(evaluateExpression("total", ctx)).toBe(12345);
    expect(evaluateExpression("te", ctx)).toBe(10);
    expect(evaluateExpression("tusd", ctx)).toBe(20);
    expect(evaluateExpression("pis", ctx)).toBe(0.0165);
    expect(evaluateExpression("cofins", ctx)).toBe(0.076);
    expect(evaluateExpression("icms", ctx)).toBe(0.18);
    expect(evaluateExpression("readingsPrevious", ctx)).toBe(100);
    expect(evaluateExpression("readingsCurrent", ctx)).toBe(150);
    expect(evaluateExpression("kwh", ctx)).toBe(50);
    expect(evaluateExpression("m3", ctx)).toBe(7);
    expect(evaluateExpression("days", ctx)).toBe(30);
  });

  it("returns undefined - not NaN, not zero - for a field the invoice does not have", () => {
    // A telecom invoice has no `tariffs` or `readings` at all.
    const ctx = ctxWith({ tariffs: undefined, readings: undefined });
    expect(evaluateExpression("icms", ctx)).toBeUndefined();
    expect(evaluateExpression("kwh", ctx)).toBeUndefined();
    expect(evaluateExpression("kwh - m3", ctx)).toBeUndefined();
  });

  it("propagates undefined through arithmetic rather than coercing to NaN", () => {
    const ctx = ctxWith({ tariffs: undefined });
    expect(evaluateExpression("total - icms", ctx)).toBeUndefined();
    expect(evaluateExpression("icms * 2", ctx)).toBeUndefined();
    expect(evaluateExpression("-icms", ctx)).toBeUndefined();
  });

  it("treats division by zero as missing data, never Infinity or NaN", () => {
    const ctx = ctxWith({ totalCents: 0 });
    expect(evaluateExpression("100 / total", ctx)).toBeUndefined();
  });
});

describe("non-finite results are rejected loudly, never silently accepted", () => {
  it("rejects a numeric literal so large it overflows to Infinity, at parse time", () => {
    // 310 digits comfortably clears Number.MAX_VALUE (~1.8e308) while
    // staying well under the 500-character source cap, so the length cap
    // alone would not have caught this.
    const hugeLiteral = "1".repeat(310);
    expect(hugeLiteral.length).toBeLessThan(500);
    expect(() => parseExpression(hugeLiteral)).toThrow(ExpressionError);
    expect(() => parseExpression(hugeLiteral)).toThrow(/invalid number/);
  });

  it("rejects an arithmetic overflow to Infinity on fields that were genuinely present", () => {
    // Each field value is itself a perfectly ordinary finite number; only
    // their product overflows. Missing-data handling must not swallow this
    // - it is not "the invoice lacks a field", it is "the rule's own
    // arithmetic broke", and must not be allowed to satisfy any threshold.
    const ctx = ctxWith({ totalCents: 1e200 });
    expect(() => evaluateExpression("total * total", ctx)).toThrow(ExpressionError);
    expect(() => evaluateExpression("total * total", ctx)).toThrow(/non-finite/);
  });

  it("rejects a NaN produced by Infinity arithmetic (Infinity - Infinity)", () => {
    const ctx = ctxWith({ totalCents: 1e200 });
    expect(() => evaluateExpression("total * total - total * total", ctx)).toThrow(/non-finite/);
  });

  it("does not confuse this with the ordinary 'missing field' case, which must still return undefined", () => {
    const ctx = ctxWith({ tariffs: undefined });
    expect(evaluateExpression("icms", ctx)).toBeUndefined();
  });
});

describe("evaluateExpression: sectionTotal / sectionCount", () => {
  const ctx = ctxWith({
    sections: [
      { name: "Saques", items: [{ description: "Saque 1", amountCents: 500 }, { description: "Saque 2", amountCents: 500 }] },
      { name: "Saques", items: [{ description: "Saque 3", amountCents: 500 }] },
      { name: "Tarifas", items: [{ description: "Tarifa X", amountCents: 100 }] },
    ],
  });

  it("sums amountCents across every section sharing that name", () => {
    expect(evaluateExpression('sectionTotal("Saques")', ctx)).toBe(1500);
  });

  it("counts items across every section sharing that name", () => {
    expect(evaluateExpression('sectionCount("Saques")', ctx)).toBe(3);
  });

  it("returns undefined for a section name the invoice does not have", () => {
    expect(evaluateExpression('sectionTotal("Não existe")', ctx)).toBeUndefined();
    expect(evaluateExpression('sectionCount("Não existe")', ctx)).toBeUndefined();
  });
});

describe("evaluateExpression: max / min", () => {
  it("picks the greater/lesser of two values (RN-003's 'greater of')", () => {
    const ctx = ctxWith({ readings: { previous: 0, current: 40, kwh: 40, estimated: false } });
    expect(evaluateExpression("max(30, kwh)", ctx)).toBe(40);
    expect(evaluateExpression("min(30, kwh)", ctx)).toBe(30);
  });

  it("propagates undefined when either argument is missing", () => {
    const ctx = ctxWith({ readings: undefined });
    expect(evaluateExpression("max(30, kwh)", ctx)).toBeUndefined();
  });
});

describe("attacks: the language must not become a code-execution path", () => {
  const ctx = ctxWith();

  it("cannot read a property it was not given via the prototype chain", () => {
    expect(() => parseExpression("__proto__")).toThrow(ExpressionError);
    expect(() => parseExpression("constructor")).toThrow(ExpressionError);
    expect(() => parseExpression("prototype")).toThrow(ExpressionError);
  });

  it("has no member-access operator at all, so a dotted path can never be written", () => {
    // "." is only ever consumed inside a numeric literal; anywhere else it
    // is simply not a legal character.
    expect(() => parseExpression("invoice.secret")).toThrow(/unexpected character/);
  });

  it("cannot name the global function constructor or any other unlisted identifier", () => {
    expect(() => parseExpression("Function")).toThrow(ExpressionError);
    expect(() => parseExpression('Function("return 1")()')).toThrow();
  });

  it("cannot call the result of a parenthesized expression", () => {
    expect(() => parseExpression("(1 + 1)(2)")).toThrow(/unexpected token/);
  });

  it("rejects an expression longer than the fixed length cap instead of scanning it", () => {
    const huge = "1" + "+1".repeat(1000);
    expect(() => parseExpression(huge)).toThrow(ExpressionError);
  });

  it("rejects pathologically deep parenthesis nesting with a clear error, not a stack overflow", () => {
    // 100 levels comfortably clears MAX_DEPTH (64) while staying well under
    // the 500-character source cap, so this specifically exercises the
    // depth guard rather than the length guard.
    const deep = "(".repeat(100) + "1" + ")".repeat(100);
    expect(() => parseExpression(deep)).toThrow(ExpressionError);
    expect(() => parseExpression(deep)).toThrow(/nested too deep/);
  });

  it("rejects pathologically deep unary-minus chains the same way", () => {
    const deep = "-".repeat(100) + "1";
    expect(() => parseExpression(deep)).toThrow(ExpressionError);
    expect(() => parseExpression(deep)).toThrow(/nested too deep/);
  });

  it("does not blow the call stack evaluating a long flat chain of the same operator", () => {
    // Same-precedence repetition is iterative in the parser, not recursive
    // (see parseExpr/parseTerm's loops), so 200 terms - well past the
    // depth cap of 64 - must still parse and evaluate fine within the
    // 500-character source cap.
    const flat = Array.from({ length: 200 }, () => "1").join("+");
    expect(evaluateExpression(flat, ctx)).toBe(200);
  });

  it("never evaluates a bare string literal as a top-level result", () => {
    expect(() => parseExpression('"hello"')).toThrow();
  });
});
