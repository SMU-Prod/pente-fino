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
  // Calibrating this against a fixed millisecond number turned out not to
  // hold: measured standalone (plain `node`) n=22 took tens of
  // milliseconds; measured inside this suite on a machine also busy with
  // other agent worktrees, the very same pattern and length ranged from
  // ~60ms to over 10 SECONDS across different runs - CPU scheduling noise
  // this large, not JIT variance. No fixed absolute threshold survives
  // that swing in either direction (too low and it stops proving
  // anything; too high and a lucky fast run fails it).
  //
  // What does survive it: comparing the dangerous pattern against an
  // equivalent *safe* one (same idea, no nested quantifier - linear, not
  // exponential) timed on the exact same input in the exact same run.
  // Both measurements land on the same loaded-or-idle machine at the same
  // moment, so their ratio cancels the machine's current speed out
  // entirely; only the difference in algorithmic complexity remains. A
  // throwaway warm-up call keeps one-time JIT compilation cost out of
  // both measurements.
  //
  // Even the ratio alone was not enough. On a real GitHub Actions run this
  // came back 616ms against a required >857ms (safe.elapsedMs * 50) - a
  // genuine ~36x, "orders of magnitude" by eye, still short of the 50x
  // floor, because a single-shot measurement can catch either side
  // mid-GC-pause or mid-JIT-tier-up and there is no way to tell afterwards
  // which one it was. Scheduler and GC noise only ever ADD delay, never
  // remove it - so `timeMatch` below takes the minimum across several
  // repeated trials rather than one sample. The true, noise-free cost is a
  // lower bound none of the samples can undercut; one clean sample among
  // several is enough to reveal it, and a single unlucky one can no longer
  // sink the whole assertion.
  const DANGEROUS_PATTERN = "(a+)+$";
  const SAFE_COMPARISON_PATTERN = "a+$"; // same idea, no nested quantifier
  const input = "a".repeat(22) + "!";
  const TIMING_TRIALS = 7;

  function timeMatch(pattern: string): { matched: boolean; elapsedMs: number } {
    new RegExp(pattern).test("a"); // warm up JIT compilation of this pattern first
    let matched = false;
    let minElapsed = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < TIMING_TRIALS; trial++) {
      const start = performance.now();
      matched = new RegExp(pattern).test(input);
      minElapsed = Math.min(minElapsed, performance.now() - start);
    }
    return { matched, elapsedMs: minElapsed };
  }

  it("the raw, unguarded catastrophic RegExp is dramatically slower than an equivalent safe one on the same input, on the same run", () => {
    const safe = timeMatch(SAFE_COMPARISON_PATTERN);
    const dangerous = timeMatch(DANGEROUS_PATTERN);
    expect(safe.matched).toBe(false);
    expect(dangerous.matched).toBe(false);
    // A linear match on a 23-character string is O(n): cheap regardless of
    // machine load. The nested-quantifier version is O(2^n) in the same n,
    // so it costs orders of magnitude more no matter how fast or slow
    // "orders of magnitude more" happens to be measured as on this run.
    expect(dangerous.elapsedMs).toBeGreaterThan(safe.elapsedMs * 50);
  }, 60_000);

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
