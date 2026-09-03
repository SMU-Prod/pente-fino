/**
 * INV-008 — no module outside @pentefino/db may reach the raw database
 * client, the raw table definitions, or the raw test-database driver. User
 * data is read through withUser(), which carries the ownership filter.
 *
 * Four independent checks run, all scoped to files outside the real
 * `packages/db` workspace package:
 *
 *   1. A named import of anything from this package's own public entry
 *      point, `@pentefino/db`, other than the small allowlist of names that
 *      do not hand out raw data access (`withUser`, `ensureAnonymousSession`,
 *      and the `Database`/`Session`/`ScopedDb` types) — static import or
 *      re-export. This is an allowlist, not a blacklist of `getUnscopedDb`
 *      and `schema` by name, on purpose: `schema` is a namespace object
 *      holding all twenty table definitions, and a fixed blacklist of two
 *      names does nothing to stop a *table* (`invoices`, `events`, ...) from
 *      being re-exported and imported directly by name, today or after the
 *      next migration adds table twenty-one.
 *   2. A namespace import of the same entry point (`import * as ns from
 *      "@pentefino/db"`) — that single binding reaches every export at
 *      once, including whichever ones check 1 would otherwise catch
 *      one-by-one, so it is rejected outright rather than inspected member
 *      by member.
 *   3. Any reach into a forbidden raw driver module — `postgres`,
 *      `drizzle-orm/postgres-js`, `drizzle-orm/pglite`, or
 *      `@electric-sql/pglite` — or any subpath beneath one, via static
 *      `import`, dynamic `import()`, `require()`, or a re-export
 *      (`export { x } from "..."`, `export * from "..."`).
 *   4. Any import of a subpath of `@pentefino/db` itself (e.g.
 *      `@pentefino/db/testing`, which hands back a live, unscoped PGlite
 *      database for tests) — except from a file that is itself a test file
 *      (see `isTestFile` below). Production code has no legitimate reason to
 *      reach a test-only subpath; a test file does.
 *
 * A legitimate unscoped caller (a background job with no user session, say)
 * can still get past checks 1, 2 and 3, but only visibly: it silences a
 * single occurrence with `// eslint-disable-next-line
 * pentefino/require-with-user` and a reason on the same line. There is no
 * path allowlist here on purpose — an allowlist hides the exception from
 * review and from grep; a disable comment does not.
 */

const FORBIDDEN_MODULES = [
  "drizzle-orm/postgres-js",
  "drizzle-orm/pglite",
  "@electric-sql/pglite",
  "postgres",
];

// Names a file outside packages/db may import from the package entry point
// without tripping the gate. Everything else — `getUnscopedDb`, `schema`,
// and every individual table it contains — hands out raw, unscoped data
// access and must go through `withUser`, or (for a real system-scoped
// caller) an explicit, visible disable comment.
const ALLOWED_PACKAGE_EXPORTS = new Set([
  "withUser",
  "ensureAnonymousSession",
  // E4 Task 4: resolves a raw session id (from a signed cookie) to the
  // `Session` withUser() scopes on, following anonymous_sessions.claimed_by_
  // user_id the same way requestClaimCode/confirmClaimCode below follow
  // their own ownership key - it hands out no raw data access of its own,
  // only the same userId/sessionId union withUser already expects.
  "resolveSession",
  "Database",
  "Session",
  "ScopedDb",
  // RF-147 (Task 7): requestClaimCode/confirmClaimCode carry their own
  // ownership check (scoped by sessionId, see claim.ts) the same way
  // withUser does, and the four constants are tuning knobs (lifetime,
  // attempts, rate limit), not raw data access.
  "requestClaimCode",
  "confirmClaimCode",
  "CLAIM_CODE_TTL_MS",
  "CLAIM_CODE_MAX_ATTEMPTS",
  "CLAIM_RATE_LIMIT_COUNT",
  "CLAIM_RATE_LIMIT_WINDOW_MS",
  // E5 Task 5's system close, called by E5 Task 3's deadline sweeper. It is
  // the opposite of raw data access: it takes one case id that the caller
  // already read out of `cases`, and it exists precisely so a job cannot
  // close a case its own way and forget to settle the findings
  // (`case-close.ts` spells out what that costs the person). There is no
  // session to scope it to and nothing it can be pointed at that the caller
  // did not already have.
  "closeCaseAsSystem",
  // E6 Task 3's reopen, called by Task 4's diff job the moment a closed
  // case's contested item reappears on invoice N+2 (RF-203). Same
  // justification as `closeCaseAsSystem` just above: it hands out no raw
  // data access, takes one case id the caller already read out of `cases`,
  // and exists so a job cannot reopen a case its own way and forget half of
  // what a reopen has to do (clear the outcome, reset `recoveredCents`,
  // move the findings back, write the trail).
  //
  // `confirmedRecoveredCents` (RF-204's metric, `metrics.ts`) is
  // deliberately NOT added here: nothing outside packages/db imports it as
  // of this task, and this allowlist is for names a real caller needs past
  // the gate, not every export this package happens to expose (the seeds
  // re-exported from `index.ts` follow the same rule - see that file's own
  // comment). Whoever builds the first consumer adds it then.
  "reopenCase",
]);

const PACKAGE_ENTRY = "@pentefino/db";
const PACKAGE_SUBPATH_PREFIX = `${PACKAGE_ENTRY}/`;

// A file counts as a test file only when BOTH its directory and its name say
// so: it must live under a `test/` (or `tests/`) segment *and* carry a
// `.test.`/`.spec.` suffix. This mirrors every vitest.config.ts in this repo
// (`test/**/*.test.ts`, `test/**/*.spec.ts` — see packages/*/vitest.config.ts
// and apps/*/vitest.config.ts), so it recognizes exactly the files the test
// runner itself would collect. Either signal alone is spoofable: a bare
// directory check would exempt any non-test file someone drops next to real
// tests (e.g. a shared helper), and a bare filename check would exempt a
// production file merely renamed to end in `.test.ts` without living
// anywhere near a real test suite. Requiring both closes that gap without
// needing a path allowlist.
const TEST_DIR_SEGMENT = /^tests?$/i;
const TEST_FILE_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/i;

function isForbiddenModule(moduleName) {
  return FORBIDDEN_MODULES.some(
    (forbidden) => moduleName === forbidden || moduleName.startsWith(`${forbidden}/`),
  );
}

/**
 * True when `filename` lives inside the real `packages/db` workspace
 * package. Anchored on path segments rather than a bare substring test: a
 * substring match on "/packages/db/" would also exempt a file like
 * `apps/other-app/packages/db/sneaky.ts`, whose `packages/db` segment is
 * nested inside a different workspace package rather than being the
 * top-level one. Handles both POSIX and Windows-style separators.
 */
function isInsideDbPackage(filename) {
  const segments = filename.replace(/\\/g, "/").split("/").filter(Boolean);
  const dbIndex = segments.findIndex((segment, i) => segment === "packages" && segments[i + 1] === "db");
  if (dbIndex === -1) return false;
  // The real `packages/db` folder is not itself nested inside another
  // workspace package or app folder.
  return !segments.slice(0, dbIndex).some((segment) => segment === "apps" || segment === "packages");
}

/** See the `TEST_DIR_SEGMENT`/`TEST_FILE_NAME` comment above for the "why". */
function isTestFile(filename) {
  const segments = filename.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = segments[segments.length - 1];
  if (!base || !TEST_FILE_NAME.test(base)) return false;
  return segments.slice(0, -1).some((segment) => TEST_DIR_SEGMENT.test(segment));
}

function nameOf(node) {
  if (!node) return undefined;
  return node.type === "Identifier" ? node.name : node.value;
}

/** @type {import("eslint").Rule.RuleModule} */
export const requireWithUser = {
  meta: {
    type: "problem",
    docs: { description: "forbid importing the raw db client or schema outside @pentefino/db" },
    messages: {
      forbidden: "Import withUser from @pentefino/db instead of the raw client (INV-008).",
      forbiddenExport:
        "Import withUser from @pentefino/db instead of {{name}} (INV-008); {{name}} is only for use inside packages/db.",
      forbiddenNamespace:
        "Import withUser from @pentefino/db instead of a namespace import (INV-008); `import * as ... from \"@pentefino/db\"` reaches every export at once, including the raw client and schema.",
      forbiddenSubpath:
        "Importing {{name}} from outside packages/db is not allowed (INV-008); this subpath hands out unscoped data access and only test files may reach it directly.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const insideDbPackage = isInsideDbPackage(filename);
    const isTest = isTestFile(filename);

    function checkModuleSource(node, moduleName) {
      if (insideDbPackage) return;
      if (typeof moduleName !== "string") return;
      if (isForbiddenModule(moduleName)) {
        context.report({ node, messageId: "forbidden" });
        return;
      }
      if (moduleName.startsWith(PACKAGE_SUBPATH_PREFIX) && !isTest) {
        context.report({ node, messageId: "forbiddenSubpath", data: { name: moduleName } });
      }
    }

    function checkNamedSpecifiers(specifiers, moduleName) {
      if (insideDbPackage || moduleName !== PACKAGE_ENTRY || !specifiers) return;
      for (const specifier of specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          context.report({ node: specifier, messageId: "forbiddenNamespace" });
          continue;
        }

        let sourceName;
        if (specifier.type === "ImportSpecifier") sourceName = nameOf(specifier.imported);
        else if (specifier.type === "ExportSpecifier") sourceName = nameOf(specifier.local);
        else continue;

        if (sourceName && !ALLOWED_PACKAGE_EXPORTS.has(sourceName)) {
          context.report({ node: specifier, messageId: "forbiddenExport", data: { name: sourceName } });
        }
      }
    }

    return {
      ImportDeclaration(node) {
        const moduleName = node.source.value;
        checkModuleSource(node, moduleName);
        checkNamedSpecifiers(node.specifiers, moduleName);
      },

      // Dynamic `import("postgres")`. Whatever binding is destructured from
      // it is out of scope for static analysis — reaching the module at all
      // is the violation.
      ImportExpression(node) {
        if (node.source && node.source.type === "Literal") {
          checkModuleSource(node, node.source.value);
        }
      },

      // CommonJS `require("postgres")`.
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length > 0 &&
          node.arguments[0].type === "Literal"
        ) {
          checkModuleSource(node, node.arguments[0].value);
        }
      },

      // `export { default as x } from "postgres"` and
      // `export { getUnscopedDb } from "@pentefino/db"`.
      ExportNamedDeclaration(node) {
        if (!node.source) return; // local re-export, no external module involved
        const moduleName = node.source.value;
        checkModuleSource(node, moduleName);
        checkNamedSpecifiers(node.specifiers, moduleName);
      },

      // `export * from "postgres"`.
      ExportAllDeclaration(node) {
        checkModuleSource(node, node.source.value);
      },
    };
  },
};
