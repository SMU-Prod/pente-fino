import { describe, expect, it } from "vitest";
import { TRIGRAM_THRESHOLD, trigramSimilarity } from "./trigram.js";

describe("trigramSimilarity", () => {
  it("is 1 for a non-empty string compared to itself", () => {
    expect(trigramSimilarity("NET FIBRA 500MB", "NET FIBRA 500MB")).toBe(1);
  });

  it("is 0 for strings that share no trigram", () => {
    expect(trigramSimilarity("AAAA", "ZZZZ")).toBe(0);
  });

  it("is symmetric", () => {
    // Deliberately different lengths (and so different trigram-set sizes
    // on each side) so a bug that treats `a` and `b` asymmetrically -
    // e.g. dividing by one side's set size instead of the union - cannot
    // hide behind a coincidentally equal set size.
    const a = "NET FIBRA 500MB";
    const b = "NET FIBRA OPTICA 300 MEGABITS";
    expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
  });

  it("is 0, not 1, for two empty inputs — an empty description is no evidence of sameness", () => {
    expect(trigramSimilarity("", "")).toBe(0);
  });

  it("is 0 for an empty string against a non-empty one", () => {
    expect(trigramSimilarity("", "NET FIBRA")).toBe(0);
  });

  it("extracts exactly n + 1 trigrams for a single word, from a two-space/one-space pad", () => {
    // "CASA" (n = 4) padded is "  CASA " (7 chars), giving 5 (= n + 1)
    // trigrams, all distinct: "  C", " CA", "CAS", "ASA", "SA "
    // "CAS" (n = 3) padded is "  CAS " (6 chars), giving 4 (= n + 1)
    // trigrams, all distinct: "  C", " CA", "CAS", "AS "
    // Shared: "  C", " CA", "CAS" -> intersection = 3.
    // Union = 5 + 4 - 3 = 6.
    // similarity = 3 / 6 = 0.5.
    // A wrong trigram count for either word (different pad length, or an
    // off-by-one in the substring loop) changes this arithmetic and this
    // assertion.
    expect(trigramSimilarity("CASA", "CAS")).toBe(0.5);
  });

  it("matches a hand-computed similarity for a short pair", () => {
    // "AB" padded is "  AB " (5 chars) -> 3 (= n + 1) trigrams:
    //   "  A", " AB", "AB "
    // "AC" padded is "  AC " (5 chars) -> 3 trigrams:
    //   "  A", " AC", "AC "
    // Shared: "  A" only -> intersection = 1.
    // Union = 3 + 3 - 1 = 5.
    // similarity = 1 / 5 = 0.2.
    expect(trigramSimilarity("AB", "AC")).toBe(0.2);
  });

  it("pins the PRD's 0.8 threshold", () => {
    expect(TRIGRAM_THRESHOLD).toBe(0.8);
  });
});
