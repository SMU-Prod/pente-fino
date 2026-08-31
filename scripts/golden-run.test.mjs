// scripts/golden-run.test.mjs
//
// Run with `node --test scripts` (wired into the root `pnpm test` — see
// package.json). Uses node:test/node:assert rather than vitest for the
// same reason scripts/golden-anonymize.test.mjs does: this script runs
// with plain Node, no build step, and the test should exercise exactly
// that same execution path.
//
// This suite is the proof, referenced in the E1 task notes, that the
// RNF-16 gate behaves correctly at both ends: it passes vacuously over an
// empty golden set (loudly saying so), and it fails — naming the exact
// case and field — the moment a case's expected.json stops matching what
// the real reader/quality/issuer-detection pipeline actually produces.
// Every fixture built below is synthetic (the existing text-2page.pdf used
// elsewhere in this repo's tests) and lives only in a throwaway temp
// directory — none of it is ever written under fixtures/golden/ itself,
// which stays genuinely empty until real invoices arrive (see this
// repo's task history for why).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { runGoldenSet, RNF_16_FLOOR, DEFAULT_GOLDEN_DIR } from "./golden-run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "fixtures", "synthetic", "pdfs");
const SCRIPT_PATH = join(HERE, "golden-run.mjs");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "golden-run-test-"));
}

// The same CNPJ/candidate shape packages/core/src/invoice/detect-issuer.test.ts
// already uses for this exact synthetic PDF's "Claro Móvel" letterhead — not a
// real issuer record, and not read from packages/db's seed data (this runner
// deliberately has no dependency on @pentefino/db; see golden-run.mjs's header
// comment and fixtures/golden/README.md for why each case carries its own
// candidate list instead).
const CLARO_CANDIDATE = {
  id: "iss_claro",
  slug: "claro-movel",
  displayName: "Claro Móvel",
  cnpj: "40432544000147",
  aliases: ["Claro", "Claro S.A."],
};

/** The ground truth for fixtures/synthetic/pdfs/text-2page.pdf, verified against the real reader/quality/issuer-detection pipeline. */
function goodExpectedJson() {
  return {
    reader: { pageCount: 2, hasTextLayer: true },
    quality: { route: "text" },
    issuer: { candidates: [CLARO_CANDIDATE], issuerId: "iss_claro", matchedOn: "cnpj" },
  };
}

function writeCase(goldenDir, caseName, expected) {
  const caseDir = join(goldenDir, caseName);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "source.pdf"), readFileSync(join(FIXTURES_DIR, "text-2page.pdf")));
  writeFileSync(join(caseDir, "expected.json"), JSON.stringify(expected, null, 2));
  return caseDir;
}

// =====================================================================
// The behaviour that matters most: empty set measures nothing, and says so.
// =====================================================================

describe("empty golden set", () => {
  test("reports zero cases and PASSES when the directory has no case subdirectories", async () => {
    const dir = tempDir();
    try {
      const report = await runGoldenSet(dir);
      assert.equal(report.caseCount, 0);
      assert.equal(report.vacuous, true);
      assert.equal(report.passed, true);
      assert.ok(report.lines.some((l) => l.includes("WARNING") && l.includes("RNF-16")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports zero cases and PASSES when the directory does not exist at all", async () => {
    const dir = join(tempDir(), "does-not-exist");
    const report = await runGoldenSet(dir);
    assert.equal(report.caseCount, 0);
    assert.equal(report.passed, true);
  });

  test("the real fixtures/golden directory is still empty and the gate passes over it", async () => {
    const report = await runGoldenSet(DEFAULT_GOLDEN_DIR);
    assert.equal(report.caseCount, 0);
    assert.equal(report.passed, true);
  });

  test("the CLI exits 0 on an empty directory and prints the loud warning", () => {
    const dir = tempDir();
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      assert.match(stdout, /golden set cases: 0/);
      assert.match(stdout, /WARNING/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// A correctly-described synthetic case: the gate passes.
// =====================================================================

describe("a correctly-described synthetic case", () => {
  test("every key field matches and the gate PASSES", async () => {
    const dir = tempDir();
    try {
      writeCase(dir, "synthetic-smoke", goodExpectedJson());
      const report = await runGoldenSet(dir);
      assert.equal(report.caseCount, 1);
      assert.equal(report.passed, true);
      for (const field of report.fields) {
        assert.equal(field.accuracy, 1, `${field.key} should be 100%`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI exits 0", () => {
    const dir = tempDir();
    try {
      writeCase(dir, "synthetic-smoke", goodExpectedJson());
      const stdout = execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      assert.match(stdout, /golden set cases: 1/);
      assert.match(stdout, /RNF-16 OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// A corrupted expected.json: proof the gate actually catches a regression.
// =====================================================================

describe("a corrupted expected.json", () => {
  test("a wrong issuer.issuerId drags that field below the floor and FAILS, naming the case and field", async () => {
    const dir = tempDir();
    try {
      const expected = goodExpectedJson();
      expected.issuer.issuerId = "iss_totally_wrong";
      const caseDir = writeCase(dir, "synthetic-smoke", expected);
      const report = await runGoldenSet(dir);
      assert.equal(report.passed, false);
      const issuerField = report.fields.find((f) => f.key === "issuer.issuerId");
      assert.ok(issuerField.accuracy < RNF_16_FLOOR);
      assert.ok(report.lines.some((l) => l.includes("issuer.issuerId") && l.includes(caseDir)));
      // The unrelated fields must stay unaffected — a regression in one
      // field must not be reported against a field that is still correct.
      const routeField = report.fields.find((f) => f.key === "quality.route");
      assert.equal(routeField.accuracy, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wrong quality.route FAILS the gate too", async () => {
    const dir = tempDir();
    try {
      const expected = goodExpectedJson();
      expected.quality.route = "vision"; // the real score for this fixture is "text"
      writeCase(dir, "synthetic-smoke", expected);
      const report = await runGoldenSet(dir);
      assert.equal(report.passed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI exits non-zero and stderr names the regressed field", () => {
    const dir = tempDir();
    try {
      const expected = goodExpectedJson();
      expected.reader.pageCount = 999;
      writeCase(dir, "synthetic-smoke", expected);

      let error;
      try {
        execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      } catch (err) {
        error = err;
      }
      assert.ok(error, "expected the CLI to exit non-zero");
      assert.notEqual(error.status, 0);
      assert.match(error.stderr, /reader\.pageCount/);
      assert.match(error.stderr, /MISMATCH/);
      assert.match(error.stderr, /RNF-16 FAILED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// Malformed cases fail loudly instead of being silently skipped.
// =====================================================================

describe("malformed cases", () => {
  test("a case directory missing source.pdf throws, naming the case", async () => {
    const dir = tempDir();
    try {
      const caseDir = join(dir, "broken");
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "expected.json"), JSON.stringify(goodExpectedJson()));
      await assert.rejects(() => runGoldenSet(dir), /source\.pdf/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a case directory missing expected.json throws, naming the case", async () => {
    const dir = tempDir();
    try {
      const caseDir = join(dir, "broken");
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "source.pdf"), readFileSync(join(FIXTURES_DIR, "text-2page.pdf")));
      await assert.rejects(() => runGoldenSet(dir), /expected\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an expected.json missing a required section throws, naming the section", async () => {
    const dir = tempDir();
    try {
      const caseDir = join(dir, "broken");
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "source.pdf"), readFileSync(join(FIXTURES_DIR, "text-2page.pdf")));
      const expected = goodExpectedJson();
      delete expected.issuer;
      writeFileSync(join(caseDir, "expected.json"), JSON.stringify(expected));
      await assert.rejects(() => runGoldenSet(dir), /"issuer"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
