// scripts/check-a11y.test.mjs
//
// Run with `node --test scripts` (wired into the root `pnpm test`).
//
// This only exercises `classifyViolations`, the pure part of
// check-a11y.mjs — the rest of that file drives a real Playwright browser
// against a real HTTP server, which does not belong in the fast unit
// suite (it has its own CI step, once the app is built and served; see
// `.github/workflows/ci.yml`). The two axe impact labels used below
// ("critical" for button-name, "serious" for color-contrast) are not
// guesses: both were confirmed empirically by deliberately breaking the
// landing page during Task 8's development and reading axe's real output
// (see the Task 8 report for the transcript) — which is exactly why
// `classifyViolations` treats "critical impact" and "color-contrast rule"
// as two independent buckets instead of one impact-based filter: a real
// contrast regression is "serious", not "critical", so a critical-only
// gate would never catch it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyViolations, TARGET_PATHS, THEMES } from "./check-a11y.mjs";

function violation(overrides) {
  return { id: "some-rule", impact: "minor", help: "some help text", nodes: [{}], ...overrides };
}

describe("classifyViolations", () => {
  test("buckets a critical violation as critical, regardless of its rule id", () => {
    const v = violation({ id: "button-name", impact: "critical" });
    const { critical, contrast } = classifyViolations([v]);
    assert.deepEqual(critical, [v]);
    assert.deepEqual(contrast, []);
  });

  test("buckets color-contrast as contrast even though axe rates it 'serious', not 'critical'", () => {
    const v = violation({ id: "color-contrast", impact: "serious" });
    const { critical, contrast } = classifyViolations([v]);
    assert.deepEqual(critical, []);
    assert.deepEqual(contrast, [v]);
  });

  test("a violation can land in both buckets if it is somehow both", () => {
    const v = violation({ id: "color-contrast", impact: "critical" });
    const { critical, contrast } = classifyViolations([v]);
    assert.deepEqual(critical, [v]);
    assert.deepEqual(contrast, [v]);
  });

  test("minor/moderate/serious non-contrast violations trip neither bucket", () => {
    const violations = [
      violation({ id: "landmark-one-main", impact: "moderate" }),
      violation({ id: "region", impact: "moderate" }),
      violation({ id: "link-name", impact: "serious" }),
    ];
    const { critical, contrast } = classifyViolations(violations);
    assert.deepEqual(critical, []);
    assert.deepEqual(contrast, []);
  });

  test("an empty violations array classifies as empty, not an error", () => {
    assert.deepEqual(classifyViolations([]), { critical: [], contrast: [] });
  });
});

describe("scan configuration", () => {
  test("always scans at least the landing page", () => {
    assert.ok(TARGET_PATHS.includes("/"));
  });

  test("verifies both themes RNF-10 asks for", () => {
    assert.deepEqual([...THEMES].sort(), ["dark", "light"]);
  });
});
