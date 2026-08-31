#!/usr/bin/env node
// scripts/golden-run.mjs
//
// The RNF-16 accuracy gate (PRD §16.2): for every case directory under
// fixtures/golden, reads `source.pdf` with the real reader
// (createUnpdfReader), scores it with the real extraction-quality signal
// (extractionQuality), and identifies its issuer with the real issuer
// detector (detectIssuer) — then compares each against the case's
// `expected.json` and reports accuracy per key field.
//
// Usage:
//   pnpm golden:run                    # scans fixtures/golden
//   node scripts/golden-run.mjs <dir>  # scans an arbitrary directory
//
// ---------------------------------------------------------------------
// THE ONE BEHAVIOUR THAT MATTERS MOST
// ---------------------------------------------------------------------
//
// With the scanned directory empty, this reports zero cases and EXITS 0 —
// there is nothing yet to measure, and it says so loudly (mirroring
// `golden:count`), rather than silently reporting success over a
// measurement of nothing. With one or more cases present, any key field
// whose accuracy across all cases falls below RNF-16's 95% floor makes it
// exit 1, naming every case/field pair that regressed.
//
// ---------------------------------------------------------------------
// WHAT THIS RUNNER ACTUALLY MEASURES (read before extending it)
// ---------------------------------------------------------------------
//
// PRD §16.2 describes a golden case as PDF + expected `InvoiceCanonical` +
// expected findings. This runner does not compare against a full
// `InvoiceCanonical` yet, because producing one is the job of the
// AI-backed extraction pipeline (a real model call), which this task does
// not wire up. What IS real today, with no external account, is the
// reader, the quality/route score and the CNPJ/alias issuer detector — so
// those are exactly what this runner exercises and gates on. A case's
// `expected.json` therefore has the narrower shape documented in
// fixtures/golden/README.md: `reader`, `quality`, `issuer`. Extending this
// runner to compare full canonical fields (amounts, dates, line items)
// belongs to whichever task wires the real AI extraction adapter in.
//
// The five key fields measured, one accuracy percentage each across every
// case: `reader.pageCount`, `reader.hasTextLayer`, `quality.route`,
// `issuer.issuerId`, `issuer.matchedOn`.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same technique as scripts/golden-anonymize.mjs: these two files have only
// type-only relative imports at runtime, so plain Node (no build step, no
// tsx) can load them directly after its own TypeScript-syntax stripping.
import { createUnpdfReader } from "../packages/adapters/src/reader/unpdf.ts";
import { extractionQuality } from "../packages/core/src/invoice/extraction-quality.ts";
import { detectIssuer } from "../packages/core/src/invoice/detect-issuer.ts";

/** RNF-16's floor: "≥ 95% de acerto por campo-chave" (PRD line 1063). */
export const RNF_16_FLOOR = 0.95;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GOLDEN_DIR = resolve(HERE, "..", "fixtures", "golden");

// One entry per key field RNF-16 measures: how to pull the actual value out
// of a run, and the expected value out of that case's expected.json.
const FIELDS = [
  { key: "reader.pageCount", actual: (r) => r.doc.pageCount, expected: (e) => e.reader.pageCount },
  { key: "reader.hasTextLayer", actual: (r) => r.doc.hasTextLayer, expected: (e) => e.reader.hasTextLayer },
  { key: "quality.route", actual: (r) => r.quality.route, expected: (e) => e.quality.route },
  { key: "issuer.issuerId", actual: (r) => r.issuer.issuerId, expected: (e) => e.issuer.issuerId },
  { key: "issuer.matchedOn", actual: (r) => r.issuer.matchedOn, expected: (e) => e.issuer.matchedOn },
];

/** Directories directly under `goldenDir` — README.md and any other stray file are ignored. */
function listCaseDirs(goldenDir) {
  if (!existsSync(goldenDir)) return [];
  return readdirSync(goldenDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(goldenDir, entry.name))
    .sort();
}

function readJson(path, caseDir, label) {
  if (!existsSync(path)) {
    throw new Error(`golden case ${caseDir} is missing ${label}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`golden case ${caseDir}: ${label} is not valid JSON (${err.message})`);
  }
}

/** Runs the real pipeline pieces against one case directory. Throws on any malformed case — never a partial, silently-skipped result. */
async function runCase(caseDir) {
  const pdfPath = join(caseDir, "source.pdf");
  if (!existsSync(pdfPath)) {
    throw new Error(`golden case ${caseDir} is missing source.pdf`);
  }
  const expected = readJson(join(caseDir, "expected.json"), caseDir, "expected.json");
  for (const section of ["reader", "quality", "issuer"]) {
    if (!expected[section]) {
      throw new Error(`golden case ${caseDir}: expected.json is missing its "${section}" section`);
    }
  }

  const bytes = new Uint8Array(readFileSync(pdfPath));
  const doc = await createUnpdfReader().read(bytes);
  const quality = extractionQuality(doc);
  const issuer = detectIssuer(doc.pages.join("\n"), expected.issuer.candidates ?? []);

  return { caseDir, doc, quality, issuer, expected };
}

function evaluateField(field, results) {
  const outcomes = results.map((result) => {
    const actualValue = field.actual(result);
    const expectedValue = field.expected(result.expected);
    return { caseDir: result.caseDir, actualValue, expectedValue, matches: Object.is(actualValue, expectedValue) };
  });
  const matches = outcomes.filter((o) => o.matches).length;
  const accuracy = matches / outcomes.length;
  return { key: field.key, total: outcomes.length, matches, accuracy, outcomes };
}

/**
 * Runs the full RNF-16 gate against `goldenDir` and returns a structured
 * report — never prints or exits itself, so tests can assert on it
 * directly instead of scraping stdout.
 */
export async function runGoldenSet(goldenDir) {
  const caseDirs = listCaseDirs(goldenDir);
  const lines = [];

  if (caseDirs.length === 0) {
    lines.push(`golden set cases: 0 (scanned ${goldenDir})`);
    lines.push("WARNING: golden set is empty — RNF-16 is not being measured. This run passes vacuously.");
    return { goldenDir, caseCount: 0, vacuous: true, passed: true, fields: [], lines };
  }

  const results = [];
  for (const caseDir of caseDirs) {
    results.push(await runCase(caseDir));
  }

  lines.push(`golden set cases: ${results.length}`);

  const fields = FIELDS.map((field) => evaluateField(field, results));
  let passed = true;
  for (const field of fields) {
    const pct = (field.accuracy * 100).toFixed(1);
    const belowFloor = field.accuracy < RNF_16_FLOOR;
    if (belowFloor) passed = false;
    lines.push(`  ${field.key}: ${field.matches}/${field.total} (${pct}%) ${belowFloor ? "BELOW FLOOR" : "OK"}`);
    if (belowFloor) {
      for (const outcome of field.outcomes.filter((o) => !o.matches)) {
        lines.push(
          `    MISMATCH in ${outcome.caseDir}: ${field.key} expected ${JSON.stringify(outcome.expectedValue)}, got ${JSON.stringify(outcome.actualValue)}`,
        );
      }
    }
  }

  if (passed) {
    lines.push(`RNF-16 OK: every key field is at or above the ${(RNF_16_FLOOR * 100).toFixed(0)}% floor.`);
  } else {
    lines.push(`RNF-16 FAILED: accuracy fell below the ${(RNF_16_FLOOR * 100).toFixed(0)}% floor on at least one key field.`);
  }

  return { goldenDir, caseCount: results.length, vacuous: false, passed, fields, lines };
}

// =====================================================================
// CLI
// =====================================================================

async function main(argv) {
  const goldenDir = argv[0] ? resolve(argv[0]) : DEFAULT_GOLDEN_DIR;
  let report;
  try {
    report = await runGoldenSet(goldenDir);
  } catch (err) {
    console.error(`golden:run failed: ${err.message}`);
    return 1;
  }
  for (const line of report.lines) {
    (report.passed ? console.log : console.error)(line);
  }
  return report.passed ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
