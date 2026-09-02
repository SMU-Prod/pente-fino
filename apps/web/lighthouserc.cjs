// apps/web/lighthouserc.cjs
//
// RNF-03 (PRD §11): "LCP da landing e das páginas SEO ≤ 2,0 s em 4G",
// verified by "Lighthouse CI no PR" — literally this file, run via
// `lhci autorun`. RNF-04: "CLS ≤ 0,05", same tool, same run.
//
// `.cjs` on purpose: apps/web/package.json has `"type": "module"`, and
// lhci's own config loader expects CommonJS `module.exports`; the `.cjs`
// extension opts this one file out of the package's ESM default without
// touching anything else.
//
// ---------------------------------------------------------------------
// SCOPE TODAY: THE LANDING PAGE ONLY — AND WHY
// ---------------------------------------------------------------------
//
// This block (E3) ships `/laudo/[id]` (the report) and `/l/[token]` (the
// public share page) in parallel with this CI task, so neither exists in
// every checkout yet. But even once their route files land, both are
// dynamic, DB-backed pages rendering a real invoice/case — this CI job
// has no Postgres service and no seeded fixture row. Measuring a fake id
// would either 500, or — worse — silently pass by timing an error page's
// trivially-fast LCP instead of the real report's. That would be the
// exact "green check that measures nothing" this task was warned about,
// so those two routes are deliberately left out of `url` below rather
// than guessed at. The warning block further down still runs on every
// invocation so their absence from this budget is never silent.
//
// Once a seeded fixture + a DB in CI exist (a bigger, separate task),
// add their real URLs to the `url` array below — everything else in this
// file already generalizes to more pages with no other change needed.

const { existsSync } = require("node:fs");
const { join } = require("node:path");

const PORT = 4173;
const urls = [`http://localhost:${PORT}/`];

for (const [route, file] of [
  ["/laudo/[id]", join("app", "laudo", "[id]", "page.tsx")],
  ["/l/[token]", join("app", "l", "[token]", "page.tsx")],
]) {
  if (existsSync(join(__dirname, file))) {
    console.warn(
      `[lighthouserc] WARNING: ${route} now exists but is NOT included in this Lighthouse budget yet — ` +
        "it needs a seeded database row in CI before its LCP/CLS would measure anything real. " +
        "See the comment at the top of apps/web/lighthouserc.cjs.",
    );
  }
}

module.exports = {
  ci: {
    collect: {
      url: urls,
      // One run keeps this job's cost down; Lighthouse's own guidance is
      // 3+ runs (median) for stable numbers on noisy hardware. Revisit if
      // this gate turns out flaky in practice — CI runners are usually
      // quiet enough for a landing page that this hasn't been necessary.
      numberOfRuns: 1,
      // `pnpm exec next start -p <port>` rather than `pnpm start -- -p
      // <port>`: pnpm's own "--" argument-forwarding mangles the
      // separator into a literal positional arg that `next start`
      // misreads as its project-directory argument (reproduced locally
      // while building this file) — `pnpm exec` hands args straight to
      // the binary with no such rewriting, and works identically on the
      // Linux CI runner and on Windows.
      startServerCommand: `pnpm exec next start -p ${PORT}`,
      startServerReadyPattern: "Ready in",
      startServerReadyTimeout: 30000,
      settings: {
        onlyCategories: ["performance"],
        // Mobile + simulated throttling is Lighthouse's own standard
        // config for "an average 4G-class connection" (default RTT/
        // throughput profile since Lighthouse 6) — this is what RNF-03's
        // "em 4G" maps to operationally; there is no separate "4G preset"
        // to name instead. Spelled out explicitly (matching current
        // Lighthouse defaults) rather than left implicit, so a future
        // Lighthouse major version changing its defaults can't silently
        // change what this gate measures.
        formFactor: "mobile",
        throttlingMethod: "simulate",
        screenEmulation: { mobile: true, width: 360, height: 640, deviceScaleFactor: 2, disabled: false },
        // Set by the CI step that installs Playwright's Chromium, so
        // this doesn't depend on whatever the runner image happens to
        // ship. Falls back to Lighthouse's own auto-detection when unset
        // (e.g. a local run without that step).
        chromePath: process.env.CHROME_PATH || undefined,
      },
      // Chromium refuses to start on GitHub's ubuntu runners without this.
      // Ubuntu 23.10+ restricts unprivileged user namespaces through
      // AppArmor, so Chrome's sandbox has nothing to build on and it aborts
      // with "No usable sandbox!" before ever binding its debug port —
      // which surfaces as `ECONNREFUSED 127.0.0.1:<port>` and a stack
      // trace, not as anything resembling a configuration error.
      //
      // This is only defensible because of what is being rendered: a
      // throwaway browser, in a throwaway container, loading this
      // repository's own app from localhost. It is not a general licence to
      // disable the sandbox anywhere a page could be attacker-controlled.
      //
      // Scoped to CI on purpose — a developer's local run keeps the sandbox,
      // since nothing forces it off there.
      chromeFlags: process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : [],
    },
    assert: {
      assertions: {
        // RNF-03: LCP <= 2.0s. Lighthouse's numeric audit value is in ms.
        "largest-contentful-paint": ["error", { maxNumericValue: 2000 }],
        // RNF-04: CLS <= 0.05.
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.05 }],
      },
    },
    upload: { target: "filesystem", outputDir: "./.lighthouseci" },
  },
};
