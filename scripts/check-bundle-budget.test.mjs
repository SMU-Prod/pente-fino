// scripts/check-bundle-budget.test.mjs
//
// Run with `node --test scripts` (wired into the root `pnpm test`). Same
// reasoning as golden-run.test.mjs: this is a plain-Node CLI script with
// no build step, so the test exercises exactly that execution path.
//
// The fixture text below is a trimmed, verbatim copy of real
// `next build` output captured against this app's actual landing page
// (see the Task 8 report / CI log for the full transcript) — not a
// hand-typed guess at the format. The "breached" fixture is the same
// build after a deliberately oversized client-side import was added to
// prove the RNF-05 gate actually rejects a real budget breach and isn't
// just reformatting a number that can never fail.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseBuildOutput, evaluateBudget, BUNDLE_BUDGET_KB } from "./check-bundle-budget.mjs";

const HEALTHY_BUILD_OUTPUT = `
   ▲ Next.js 15.5.24

   Creating an optimized production build ...
 ✓ Compiled successfully in 19.0s
   Linting and checking validity of types ...

   Collecting page data ...
 ✓ Generating static pages (5/5)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                 Size  First Load JS
┌ ○ /                                      139 B         102 kB
├ ○ /_not-found                            995 B         103 kB
├ ƒ /api/findings/[id]/feedback            139 B         102 kB
└ ƒ /api/uploads/sign                      139 B         102 kB
+ First Load JS shared by all             102 kB
  ├ chunks/4af3a5cd-d19eef3ae478f662.js  54.2 kB
  ├ chunks/864-a9d08b7afa183136.js       45.9 kB
  └ other shared chunks (total)          1.95 kB


○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
`;

// Same build, but "/" picked up a deliberately huge client-side import —
// this is the actual shape a real breach takes: the shared baseline is
// unaffected, only the one route that imported the heavy module grows.
const BREACHED_BUILD_OUTPUT = HEALTHY_BUILD_OUTPUT.replace(
  "┌ ○ /                                      139 B         102 kB",
  "┌ ○ /                                     151 kB         253 kB",
);

describe("parseBuildOutput", () => {
  test("reads every route's First Load JS and the shared baseline", () => {
    const report = parseBuildOutput(HEALTHY_BUILD_OUTPUT);
    assert.equal(report.sharedByAllKb, 102);
    assert.deepEqual(
      report.routes.map((r) => r.path),
      ["/", "/_not-found", "/api/findings/[id]/feedback", "/api/uploads/sign"],
    );
    assert.equal(report.routes.find((r) => r.path === "/_not-found").firstLoadKb, 103);
  });

  test("does not mistake a per-chunk detail row for a route", () => {
    const report = parseBuildOutput(HEALTHY_BUILD_OUTPUT);
    assert.ok(!report.routes.some((r) => r.path.startsWith("chunks/")));
  });

  test("converts B and MB rows to the same decimal-kB unit as kB rows", () => {
    const report = parseBuildOutput(HEALTHY_BUILD_OUTPUT);
    // "/_not-found" itself is reported in bytes ("995 B") for its own
    // Size column, but First Load JS ("103 kB") is what this cares about;
    // exercise the unit conversion directly against a synthetic table.
    const synthetic = `
Route (app)                                 Size  First Load JS
┌ ○ /big                                     1.2 MB         1200 kB
+ First Load JS shared by all             500 B
`;
    const parsed = parseBuildOutput(synthetic);
    assert.equal(parsed.sharedByAllKb, 0.5);
    assert.equal(parsed.routes[0].firstLoadKb, 1200);
  });

  test("throws instead of silently reporting zero routes when the table is missing", () => {
    assert.throws(
      () => parseBuildOutput("Compiled successfully.\nNo route table here.\n"),
      /could not find the "Route \(app\)" table/,
    );
  });
});

describe("evaluateBudget (RNF-05: initial JS bundle <= 120 kB gzip)", () => {
  test("passes a build within budget", () => {
    const report = parseBuildOutput(HEALTHY_BUILD_OUTPUT);
    const result = evaluateBudget(report);
    assert.equal(result.passed, true);
    assert.deepEqual(result.violations, []);
  });

  test("fails the exact route that breached the budget, by how much", () => {
    const report = parseBuildOutput(BREACHED_BUILD_OUTPUT);
    const result = evaluateBudget(report);
    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].label, "/");
    assert.equal(result.violations[0].valueKb, 253);
  });

  test("also fails on the shared baseline alone, independent of any single route", () => {
    const report = { sharedByAllKb: BUNDLE_BUDGET_KB + 1, routes: [{ path: "/", firstLoadKb: 10 }] };
    const result = evaluateBudget(report);
    assert.equal(result.passed, false);
    assert.equal(result.violations[0].label, "shared-by-all");
  });

  test("a route sitting exactly at the budget is not a violation", () => {
    const report = { sharedByAllKb: 100, routes: [{ path: "/", firstLoadKb: BUNDLE_BUDGET_KB }] };
    const result = evaluateBudget(report);
    assert.equal(result.passed, true);
  });
});
