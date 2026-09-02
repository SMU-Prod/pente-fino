// scripts/ts-sibling-loader.mjs
//
// A Node ESM "resolve" hook (node:module's `register()`) that lets a plain
// `node` process import a TypeScript module whose OWN relative imports use
// the ".js" extension — the convention every TypeScript source in this repo
// follows for NodeNext module resolution (e.g. `packages/ai/src/lint.ts`
// does `import { FORBIDDEN_TERMS } from "./forbidden-terms.js"`) even though
// no build step ever produces that literal .js file; `packages/ai` and
// `packages/core` have no "build" script at all (see their package.json —
// "main" and "exports" point straight at "./src/index.ts").
//
// Node's own type-stripping (used throughout scripts/*.mjs to import .ts
// sources with zero build step — see golden-run.mjs's header comment)
// erases type-only syntax, including `import type` declarations entirely,
// but it does NOT bridge this extension mismatch for a REAL (value-level)
// import: it looks for a literal sibling ".js" file and fails. That is
// exactly why golden-run.mjs and golden-anonymize.mjs get away with no
// loader at all — every relative import their two entry points touch
// happens to be `import type`, erased before the resolver ever sees it.
//
// scripts/eval-contest.mjs needs the real `lintUserFacingText`, not a
// re-derived copy of its regex/plural/citation-exemption logic — a copy
// would silently drift from the actual §14.3 gate the moment either one
// changed, which is exactly the kind of vacuous check this project has
// shipped before. `lint.ts`'s import of `./forbidden-terms.js` is a real,
// value-level import (the arrays are used at runtime), so this hook is
// what makes loading it from plain `node` possible without a build step,
// identically on Windows and Linux — pure `node:module`/URL resolution,
// no OS-specific path handling.
//
// Scope is deliberately narrow: only a specifier ending in ".js" that fails
// to resolve is retried once as ".ts". Anything else — a missing package, a
// typo, a genuinely missing file — still throws Node's own error unchanged.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && specifier.endsWith(".js")) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
