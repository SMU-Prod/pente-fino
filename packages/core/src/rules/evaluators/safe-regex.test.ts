import { describe, expect, it } from "vitest";
import { assertSafePattern, compileSafePattern, UnsafePatternError } from "./safe-regex.js";

describe("assertSafePattern: rejects the two catastrophic-backtracking shapes", () => {
  it.each([
    "(a+)+",
    "(a*)*",
    "(a?)+", // the classic case even without a literal '+'/'*' inside
    "(a+)*",
    "(SVA+)+",
    "([A-Z]+)+", // a quantified character class counts as an inner quantifier too
    "(\\d{2,4})+", // a brace quantifier counts too
  ])("rejects a quantified group containing another quantifier: %s", (source) => {
    expect(() => assertSafePattern(source)).toThrow(UnsafePatternError);
    expect(() => assertSafePattern(source)).toThrow(/nested|quantifier/i);
  });

  it.each(["(a|a)+", "(a|ab)+", "(SEGURO|PROTECAO)*", "(a|b){2,4}"])(
    "rejects alternation inside a quantified group: %s",
    (source) => {
      expect(() => assertSafePattern(source)).toThrow(UnsafePatternError);
      expect(() => assertSafePattern(source)).toThrow(/alternation/i);
    },
  );

  it("rejects the dangerous shape however deeply it is nested", () => {
    expect(() => assertSafePattern("((a+))+")).toThrow(UnsafePatternError);
    expect(() => assertSafePattern("x(y(a+)z)+w")).toThrow(UnsafePatternError);
  });

  it("rejects the dangerous shape inside non-capturing and named groups too", () => {
    expect(() => assertSafePattern("(?:a+)+")).toThrow(UnsafePatternError);
    expect(() => assertSafePattern("(?<x>a+)+")).toThrow(UnsafePatternError);
  });

  it("rejects a pattern longer than the length cap", () => {
    expect(() => assertSafePattern("a".repeat(201))).toThrow(UnsafePatternError);
    expect(() => assertSafePattern("a".repeat(201))).toThrow(/character limit/);
  });
});

describe("assertSafePattern: still allows what §12's rules genuinely need", () => {
  it.each([
    "SVA",
    "SEGURO|PROTECAO|GARANTIA ESTENDIDA", // bare alternation, not inside a quantified group
    "SERVICOS.*DIGITAL",
    "SVA+", // a single quantifier, not wrapped in a further repeated group
    "\\d{2,4}",
    "(SVA)", // a group used once, not repeated
    "(AB)+", // a repeated group whose content has no quantifier/alternation of its own
    "(SVA){2,3}",
    "[A-Z]+",
    "[0-9]{2,4}",
    "^SVA$",
    "(?:SVA)+", // non-capturing group, same safe shape
    "(?<tag>SVA)", // named group, used once
    "(?<=PLANO )SVA", // positive lookbehind, used once
    "(?<!CANCELADO )SVA", // negative lookbehind, used once
  ])("allows: %s", (source) => {
    expect(() => assertSafePattern(source)).not.toThrow();
  });

  it("compileSafePattern returns a working RegExp for a safe pattern", () => {
    const re = compileSafePattern("SVA|SEGURO");
    expect(re.test("PLANO SVA TURBO")).toBe(true);
    expect(re.test("PLANO MENSAL")).toBe(false);
  });

  it("compileSafePattern throws before ever compiling an unsafe pattern", () => {
    expect(() => compileSafePattern("(a+)+")).toThrow(UnsafePatternError);
  });
});

describe("assertSafePattern: robustness on malformed/edge-case input", () => {
  it("does not throw on a character class containing regex metacharacters", () => {
    expect(() => assertSafePattern("[+*?|()]+")).not.toThrow();
  });

  it("does not treat a literal leading ']' inside a class as the closer", () => {
    expect(() => assertSafePattern("[]a]+")).not.toThrow();
  });

  it("does not treat an escaped parenthesis as a group", () => {
    expect(() => assertSafePattern("\\(a\\)+")).not.toThrow();
  });

  it("does not treat '{' with no valid quantifier body as a quantifier", () => {
    expect(() => assertSafePattern("{not a quantifier}")).not.toThrow();
  });

  it("handles an unterminated group without throwing from the scanner itself", () => {
    // Invalid regex syntax is `new RegExp`'s problem to reject, not this
    // scanner's - it only has to be safe against the two dangerous shapes.
    expect(() => assertSafePattern("(a+")).not.toThrow();
    expect(() => compileSafePattern("(a+")).toThrow(); // still fails, just at RegExp construction
  });

  it("handles a trailing lazy quantifier without double-counting it as a second quantifier", () => {
    expect(() => assertSafePattern("(AB)+?")).not.toThrow();
  });
});

describe("empirical proof: the guard actually holds against real catastrophic backtracking", () => {
  // (a+)+$ against a run of "a"s followed by a non-matching character is
  // the textbook catastrophic-backtracking case: the engine tries every
  // way of partitioning the "a"s between the inner and outer "+" before
  // concluding the match fails, which is exponential in the run length.
  //
  // n=24 was calibrated standalone (plain `node`, no test-runner overhead)
  // at ~250ms; measured again from inside this suite (vitest + v8 coverage
  // + parallel workers) it took ~5s - a >1000x margin either way above the
  // sub-millisecond an ordinary regex match costs, but a reminder that
  // absolute timing under a test runner is noisy. The assertions below are
  // deliberately one-sided and generous in both directions - a low floor
  // that is still unambiguously "not a normal match", and a timeout with
  // wide headroom over the worst run actually observed - rather than
  // pinned to either measurement.
  const DANGEROUS_PATTERN = "(a+)+$";
  const input = "a".repeat(24) + "!";

  it("the raw, unguarded RegExp is measurably slow on this input", () => {
    const start = performance.now();
    const matched = new RegExp(DANGEROUS_PATTERN).test(input);
    const elapsed = performance.now() - start;
    expect(matched).toBe(false);
    // 50ms is roughly two orders of magnitude above what any ordinary,
    // non-catastrophic regex match costs, and comfortably below every
    // measurement taken while calibrating this (250ms standalone, ~5s
    // under this suite's runner).
    expect(elapsed).toBeGreaterThan(50);
  }, 30_000);

  it("assertSafePattern rejects the same pattern near-instantly, never reaching the regex engine", () => {
    const start = performance.now();
    expect(() => assertSafePattern(DANGEROUS_PATTERN)).toThrow(UnsafePatternError);
    const elapsed = performance.now() - start;
    // Static string scanning over a 6-character pattern - not remotely
    // close to the 100ms+ the unguarded version above takes on the exact
    // same adversarial shape.
    expect(elapsed).toBeLessThan(50);
  });
});
