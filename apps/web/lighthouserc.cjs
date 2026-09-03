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
  ["/caso/[id]", join("app", "caso", "[id]", "page.tsx")],
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
      // Three runs, median. The previous note here said one run was enough
      // and to "revisit if this gate turns out flaky in practice". It did,
      // on 02/09/2026: commit 5f218a5 failed with an LCP of 2278 ms against
      // the 2000 ms budget, and the *same commit* passed on a re-run with
      // nothing changed. The First Load JS table was byte-identical between
      // the two runs (102 kB for `/`), so what moved was the runner, not the
      // page.
      //
      // That is worse than it sounds. A gate that fails randomly gets
      // re-run until it passes, and a gate people have learned to re-run is
      // not a gate — it is a delay. Three runs against the median is
      // Lighthouse's own guidance for noisy hardware, and the cost is about
      // 25 seconds of CI.
      numberOfRuns: 3,
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
        // Chromium refuses to start on GitHub's ubuntu runners without
        // this: Ubuntu 23.10+ restricts unprivileged user namespaces
        // through AppArmor, so Chrome's sandbox has nothing to build on
        // and aborts with "No usable sandbox!" before ever binding its
        // debug port — surfacing as `ECONNREFUSED 127.0.0.1:<port>` and a
        // stack trace, not as anything resembling a configuration error.
        //
        // It belongs HERE, inside `settings`, as a space-separated STRING.
        // lhci reads `options.settings.chromeFlags` and concatenates it
        // (see @lhci/cli/src/collect/node-runner.js); a `chromeFlags` array
        // placed beside `settings` is silently ignored, which is exactly
        // how the first attempt at this fix failed a second CI run with an
        // identical stack trace.
        //
        // Defensible only because of what is rendered: a throwaway browser,
        // in a throwaway container, loading this repository's own app from
        // localhost. Scoped to CI, so a local run keeps its sandbox.
        chromeFlags: process.env.CI ? "--no-sandbox --disable-dev-shm-usage" : undefined,
      },
    },
    assert: {
      // `median`, stated rather than left to the default. lhci's default
      // aggregation is "optimistic", which for a `maxNumericValue` assertion
      // takes the *best* of the runs — that would turn three runs into a
      // licence to pass on the luckiest one, which is the opposite of why
      // the run count went up.
      aggregationMethod: "median",
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
