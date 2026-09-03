#!/usr/bin/env node
// scripts/check-a11y.mjs
//
// RNF-09 (PRD §11): "Acessibilidade — WCAG 2.1 AA nas telas principais",
// verified by "axe no CI + teste de teclado". This wires the axe half —
// see the note at the bottom of this file about the keyboard-navigation
// half, which this script does not attempt.
//
// RNF-10: "Contraste e tema — Claro e escuro, tokens completos",
// verified by "Teste visual nos dois temas". A full pixel-level visual
// regression harness for both themes doesn't exist in this repo yet and
// is a bigger lift than this task's scope — axe's own `color-contrast`
// rule, run once per theme, is the closest automated proxy available
// today and is what this script uses. That's a deliberate, named
// approximation, not the full "visual test" RNF-10 describes.
//
// Usage:
//   node scripts/check-a11y.mjs http://localhost:4173
//
// ---------------------------------------------------------------------
// WHY "CRITICAL" AND "CONTRAST" ARE TWO SEPARATE, BOTH-FATAL BUCKETS
// ---------------------------------------------------------------------
//
// The task that specified this gate asks for "no critical violation" —
// axe-core's own `impact` field, which only 4 rules across its entire
// ruleset ever report as "critical" (things like missing/duplicate
// document `lang`, or completely inaccessible iframes/regions). If this
// script gated ONLY on `impact === "critical"`, RNF-10's own contrast
// requirement would be toothless: axe classifies `color-contrast`
// violations as "serious", not "critical", so a real contrast regression
// would never trip a critical-only gate. This script therefore fails the
// build on either: any `impact === "critical"` violation (RNF-09, as
// specified), OR any `color-contrast` violation regardless of axe's own
// impact label (RNF-10, using contrast as the proxy described above).
// Every violation of any severity is still printed for visibility — only
// the fatal-or-not decision is scoped this way.
//
// ---------------------------------------------------------------------
// WHAT "THE REPORT AND PUBLIC PAGES" MEANS TODAY
// ---------------------------------------------------------------------
//
// `/laudo/[id]` (the report) and `/l/[token]` (the public share page) are
// being built in parallel with this task and do not exist yet — and even
// once their route files exist, both are dynamic, DB-backed pages
// (RF-143/RF-146: real invoice/case data, no login). This CI job has no
// Postgres service and no seeded fixture row, so hitting either with a
// fabricated id/token would 500 or render a generic error page — the
// exact "green check measuring nothing" trap this task was warned about,
// since an error page's near-empty DOM would trivially pass axe. Rather
// than fake that coverage, this script scans for those route files and
// prints a loud, specific warning if it finds one NOT already covered —
// naming exactly what's missing (a seeded database row in CI) — instead
// of silently including or silently ignoring it. The moment a route can
// be given a real, meaningful URL to hit, add it to TARGET_PATHS below.

import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_APP_DIR = resolve(HERE, "..", "apps", "web", "app");

/** Routes this script actually scans today. Extend this once a route below can be given a real, data-backed URL — see the file header. */
export const TARGET_PATHS = ["/"];

/** Route files this script knows *should* eventually be scanned, and isn't yet — purely for the "not covered" warning; never auto-added to TARGET_PATHS (see file header for why). */
const KNOWN_FUTURE_ROUTES = [
  { path: "/laudo/[id]", file: join("laudo", "[id]", "page.tsx") },
  { path: "/l/[token]", file: join("l", "[token]", "page.tsx") },
  { path: "/caso/[id]", file: join("caso", "[id]", "page.tsx") },
];

/** Themes RNF-10 asks to be verified in — set via `data-theme` per packages/ui/src/tokens.css. */
export const THEMES = ["light", "dark"];

/**
 * Splits one axe `violations` array into the two fatal buckets this gate
 * cares about. Pure and synchronous — no browser needed — so this is unit
 * tested directly without spinning up Playwright.
 */
export function classifyViolations(violations) {
  const critical = violations.filter((v) => v.impact === "critical");
  const contrast = violations.filter((v) => v.id === "color-contrast");
  return { critical, contrast };
}

function warnUncoveredFutureRoutes() {
  for (const route of KNOWN_FUTURE_ROUTES) {
    if (TARGET_PATHS.includes(route.path)) continue;
    if (existsSync(join(WEB_APP_DIR, route.file))) {
      console.warn(
        `[check-a11y] WARNING: ${route.path} now exists but is NOT covered by this axe gate yet. ` +
          `It is a dynamic, DB-backed route with no seeded fixture in CI — add it to TARGET_PATHS in ` +
          `scripts/check-a11y.mjs once it can be hit with a real invoice/case id, rather than a fake one ` +
          `that would only 500 or render an error page.`,
      );
    }
  }
}

async function scanUrl(page, url, theme) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  // Let any theme-dependent styling settle before axe reads computed styles.
  await page.waitForTimeout(50);
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations;
}

/**
 * Runs the full RNF-09/RNF-10 gate against `baseUrl`. Never prints or
 * exits itself, mirroring golden-run.mjs / check-bundle-budget.mjs.
 */
export async function runA11yCheck(baseUrl) {
  warnUncoveredFutureRoutes();

  if (TARGET_PATHS.length === 0) {
    throw new Error("check-a11y: TARGET_PATHS is empty — there is nothing to scan, which is never correct here.");
  }

  const lines = [];
  const allCritical = [];
  const allContrast = [];

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of TARGET_PATHS) {
      const url = new URL(path, baseUrl).toString();
      for (const theme of THEMES) {
        const violations = await scanUrl(page, url, theme);
        const { critical, contrast } = classifyViolations(violations);

        lines.push(`${url} [data-theme=${theme}]: ${violations.length} violation(s) total`);
        for (const v of violations) {
          lines.push(`  - [${v.impact ?? "n/a"}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
        }

        for (const v of critical) allCritical.push({ url, theme, ...v });
        for (const v of contrast) allContrast.push({ url, theme, ...v });
      }
    }
  } finally {
    await browser.close();
  }

  const passed = allCritical.length === 0 && allContrast.length === 0;

  if (allCritical.length > 0) {
    lines.push(`RNF-09 FAILED: ${allCritical.length} critical violation(s) found.`);
    for (const v of allCritical) lines.push(`  CRITICAL at ${v.url} [${v.theme}]: ${v.id} — ${v.help}`);
  } else {
    lines.push("RNF-09 OK: no critical violation.");
  }

  if (allContrast.length > 0) {
    lines.push(`RNF-10 FAILED: ${allContrast.length} color-contrast violation(s) found across light/dark.`);
    for (const v of allContrast) lines.push(`  CONTRAST at ${v.url} [${v.theme}]: ${v.help}`);
  } else {
    lines.push("RNF-10 OK: no color-contrast violation in either theme.");
  }

  return { passed, critical: allCritical, contrast: allContrast, lines };
}

// =====================================================================
// CLI
// =====================================================================

async function main(argv) {
  const baseUrl = argv[0];
  if (!baseUrl) {
    console.error("usage: node scripts/check-a11y.mjs <base-url>");
    return 1;
  }

  let result;
  try {
    result = await runA11yCheck(baseUrl);
  } catch (err) {
    console.error(`check-a11y failed: ${err.message}`);
    return 1;
  }

  for (const line of result.lines) {
    console.log(line);
  }
  return result.passed ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

// ---------------------------------------------------------------------
// WHAT THIS DOES NOT COVER
// ---------------------------------------------------------------------
//
// RNF-09's own verification method is "axe no CI + teste de teclado" —
// this script is only the axe half. No keyboard-navigation E2E test was
// requested or added by this task; it stays an explicit, named gap
// rather than something this file's passing exit code silently implies.
