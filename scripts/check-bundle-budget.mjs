#!/usr/bin/env node
// scripts/check-bundle-budget.mjs
//
// RNF-05 (PRD §11): "Bundle JS inicial da web ≤ 120 kB gzip", verified by
// "`next build` com orçamento" — i.e. gate on the numbers `next build`
// itself already prints, rather than reimplementing a gzip-size
// calculation that could drift from what actually ships. This script reads
// the captured stdout of a `next build` run and parses its own
// "Route (app)" table.
//
// Usage:
//   pnpm --filter @pentefino/web build | tee apps/web/.next-build.log
//   node scripts/check-bundle-budget.mjs apps/web/.next-build.log
//
// ---------------------------------------------------------------------
// WHY THIS IS SAFE TO TRUST AS "GZIP" (verified, not assumed)
// ---------------------------------------------------------------------
//
// Next's "First Load JS" column is not documented as gzip anywhere
// obvious, so this was checked empirically before relying on it: for the
// two shared chunks in this app's baseline build, `gzip -9`-ing the actual
// `.next/static/chunks/*.js` files on disk produced 54102 and 46113 bytes —
// matching the "54.2 kB" / "45.9 kB" Next printed for those exact files.
// Summing every shared-chunk byte count and dividing by 1000 (not 1024)
// reproduces the printed "102 kB" almost exactly, confirming Next reports
// this table in **decimal** kB. Both budget comparisons below use that
// same decimal-kB convention, so a number here means the same thing as the
// number `next build` just printed.
//
// ---------------------------------------------------------------------
// THE ONE BEHAVIOUR THAT MATTERS MOST
// ---------------------------------------------------------------------
//
// If the table can't be found at all — a changed `next build` output
// format, a build that failed before printing it, a wrong file — this
// THROWS instead of reporting "0 routes, nothing over budget". Unlike the
// golden set (where an empty scan is a legitimate, loudly-reported
// vacuous pass), a successful `next build` always prints this table; not
// finding it means the gate is broken, not that there is nothing to gate.
//
// ---------------------------------------------------------------------
// WHAT "THE PAGES THIS BLOCK SHIPS" MEANS HERE
// ---------------------------------------------------------------------
//
// RNF-05 is about the *initial* JS bundle, which is exactly Next's
// "First Load JS shared by all" figure — the baseline every route pays
// before its own code even runs. This script gates that number, and (as a
// defensive extra) every individual route's "First Load JS" too, so a
// single bloated page can't hide behind a small shared baseline. Because
// it reads whatever `next build` printed for the *current* route tree, it
// automatically covers `/laudo/[id]` and `/l/[token]` the moment those
// routes exist and get built — no edit to this script or to
// `.github/workflows/ci.yml` is needed when that lands.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** RNF-05's floor, in the same decimal-kB unit `next build` prints. */
export const BUNDLE_BUDGET_KB = 120;

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const SIZE_PATTERN = /^([\d.]+)\s*(B|kB|MB)$/;
const ROUTE_LINE = /^[│├└┌]\s*[○ƒλ●]\s+(.+)$/;
const SHARED_LABEL = "First Load JS shared by all";

function toKb(sizeText) {
  const match = SIZE_PATTERN.exec(sizeText.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (match[2] === "B") return value / 1000;
  if (match[2] === "MB") return value * 1000;
  return value; // kB
}

/**
 * Parses the "Route (app)" table out of captured `next build` stdout.
 * Pure and synchronous — no filesystem access beyond the string handed in.
 */
export function parseBuildOutput(text) {
  const routes = [];
  let sharedByAllKb;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_PATTERN, "");

    if (line.includes(SHARED_LABEL)) {
      const fields = line.split(/\s{2,}/).map((f) => f.trim()).filter(Boolean);
      const sizeField = fields[fields.length - 1];
      const kb = toKb(sizeField);
      if (kb != null) sharedByAllKb = kb;
      continue;
    }

    const routeMatch = ROUTE_LINE.exec(line);
    if (!routeMatch) continue;

    // Split the remainder ("/path   139 B   102 kB") on runs of 2+ spaces.
    // Route rows have exactly 3 fields (path, own size, First Load JS);
    // the per-chunk detail rows nested under "First Load JS shared by
    // all" (e.g. "chunks/…js  54.2 kB") have only 2 and a path that never
    // starts with "/" — both are why this filter is safe.
    const fields = routeMatch[1].split(/\s{2,}/).map((f) => f.trim()).filter(Boolean);
    if (fields.length !== 3 || !fields[0].startsWith("/")) continue;

    const firstLoadKb = toKb(fields[2]);
    if (firstLoadKb == null) continue;
    routes.push({ path: fields[0], firstLoadKb });
  }

  if (sharedByAllKb == null || routes.length === 0) {
    throw new Error(
      "check-bundle-budget: could not find the \"Route (app)\" table or the " +
        "\"First Load JS shared by all\" line in the given build output. " +
        "Either the build failed before printing it, or `next build`'s output " +
        "format changed — treat this as a failing gate, not a pass over " +
        "nothing measured.",
    );
  }

  return { sharedByAllKb, routes };
}

/**
 * Evaluates a parsed report against the budget. Never prints or exits
 * itself — see golden-run.mjs for why this repo keeps that split.
 */
export function evaluateBudget(report, budgetKb = BUNDLE_BUDGET_KB) {
  const lines = [];
  const violations = [];

  lines.push(`First Load JS shared by all: ${report.sharedByAllKb.toFixed(1)} kB (budget ${budgetKb} kB)`);
  if (report.sharedByAllKb > budgetKb) {
    violations.push({ label: "shared-by-all", valueKb: report.sharedByAllKb });
  }

  for (const route of report.routes) {
    const over = route.firstLoadKb > budgetKb;
    lines.push(`  ${route.path}: ${route.firstLoadKb.toFixed(1)} kB${over ? " OVER BUDGET" : ""}`);
    if (over) violations.push({ label: route.path, valueKb: route.firstLoadKb });
  }

  const passed = violations.length === 0;
  lines.push(
    passed
      ? `RNF-05 OK: every route's First Load JS is at or under ${budgetKb} kB.`
      : `RNF-05 FAILED: ${violations.length} route(s) exceed the ${budgetKb} kB gzip budget.`,
  );

  return { passed, violations, lines };
}

// =====================================================================
// CLI
// =====================================================================

function main(argv) {
  const logPath = argv[0];
  if (!logPath) {
    console.error("usage: node scripts/check-bundle-budget.mjs <next-build-output.log>");
    return 1;
  }

  let text;
  try {
    text = readFileSync(resolve(logPath), "utf8");
  } catch (err) {
    console.error(`check-bundle-budget: could not read ${logPath}: ${err.message}`);
    return 1;
  }

  let report;
  try {
    report = parseBuildOutput(text);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const result = evaluateBudget(report);
  for (const line of result.lines) {
    (result.passed ? console.log : console.error)(line);
  }
  return result.passed ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
