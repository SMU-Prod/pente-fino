import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { requireWithUser } from "@pentefino/config/eslint/rules/require-with-user.js";

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("INV-008 · no query outside packages/db reaches the raw client", () => {
  it("reports a raw client import from an app file", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import { withUser } from "@pentefino/db";`, filename: "/repo/apps/web/app/page.ts" },
        { code: `import postgres from "postgres";`, filename: "/repo/packages/db/src/client.ts" },
      ],
      invalid: [
        {
          code: `import postgres from "postgres";`,
          filename: "/repo/apps/web/app/page.ts",
          errors: [{ messageId: "forbidden" }],
        },
        {
          code: `import { drizzle } from "drizzle-orm/postgres-js";`,
          filename: "/repo/apps/web/lib/db.ts",
          errors: [{ messageId: "forbidden" }],
        },
      ],
    });
  });

  it("reports a raw client import on a Windows-style backslash path", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import postgres from "postgres";`, filename: "C:\\repo\\packages\\db\\src\\client.ts" },
      ],
      invalid: [
        {
          code: `import postgres from "postgres";`,
          filename: "C:\\repo\\apps\\web\\app\\page.ts",
          errors: [{ messageId: "forbidden" }],
        },
      ],
    });
  });

  // --- Critical 1 -----------------------------------------------------
  // The public API handed out the raw client (`getDb`) and the raw schema
  // (`schema`) via an ordinary named import from `@pentefino/db`, and the
  // original rule only matched a fixed list of driver module *specifiers*
  // — it never inspected which *names* a file imported. Renaming the export
  // to `getUnscopedDb` makes reaching past the gate greppable on its own;
  // this closes the other half by having the rule flag the import itself.
  it("reports a named import of getUnscopedDb or schema from the public entry point", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import { withUser } from "@pentefino/db";`, filename: "/repo/apps/web/lib/invoices.ts" },
        {
          // The exemption for files inside packages/db applies to this
          // check the same way it applies to the raw-driver check.
          code: `import { getUnscopedDb, schema } from "@pentefino/db";`,
          filename: "C:\\repo\\packages\\db\\src\\some-internal-file.ts",
        },
      ],
      invalid: [
        {
          code: `import { getUnscopedDb } from "@pentefino/db";`,
          filename: "/repo/apps/web/lib/invoices.ts",
          errors: [{ messageId: "forbiddenExport" }],
        },
        {
          code: `import { schema } from "@pentefino/db";`,
          filename: "/repo/apps/web/lib/invoices.ts",
          errors: [{ messageId: "forbiddenExport" }],
        },
        {
          // The exact reproduction from the audit: both raw exports pulled
          // in through one ordinary static import, then used directly.
          code: `import { getUnscopedDb, schema } from "@pentefino/db";\ngetUnscopedDb().select().from(schema.invoices);`,
          filename: "/repo/apps/web/lib/invoices.ts",
          errors: [{ messageId: "forbiddenExport" }, { messageId: "forbiddenExport" }],
        },
        {
          // Aliasing the local binding does not hide the imported name.
          code: `import { getUnscopedDb as db } from "@pentefino/db";`,
          filename: "C:\\repo\\apps\\web\\lib\\invoices.ts",
          errors: [{ messageId: "forbiddenExport" }],
        },
        {
          // A re-export is just as much of a hand-off as a direct import.
          code: `export { getUnscopedDb } from "@pentefino/db";`,
          filename: "/repo/apps/web/lib/reexport.ts",
          errors: [{ messageId: "forbiddenExport" }],
        },
      ],
    });
  });

  // --- Critical 2 -----------------------------------------------------
  // The rule only listened for `ImportDeclaration`. Dynamic `import()`,
  // `require()`, and both named and star re-exports reach a forbidden
  // driver module without ever producing an `ImportDeclaration` node.
  it("reports a forbidden module reached via dynamic import, require, or re-export", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `const m = await import("postgres");`, filename: "/repo/packages/db/src/x.ts" },
        { code: `const m = require("postgres");`, filename: "/repo/packages/db/src/x.ts" },
        { code: `export { default as x } from "postgres";`, filename: "/repo/packages/db/src/x.ts" },
        { code: `export * from "postgres";`, filename: "/repo/packages/db/src/x.ts" },
      ],
      invalid: [
        {
          code: `const m = await import("postgres");`,
          filename: "/repo/apps/web/lib/x.ts",
          errors: [{ messageId: "forbidden" }],
        },
        {
          code: `const m = require("postgres");`,
          filename: "/repo/apps/web/lib/x.ts",
          errors: [{ messageId: "forbidden" }],
        },
        {
          code: `export { default as x } from "postgres";`,
          filename: "/repo/apps/web/lib/x.ts",
          errors: [{ messageId: "forbidden" }],
        },
        {
          code: `export * from "postgres";`,
          filename: "C:\\repo\\apps\\web\\lib\\x.ts",
          errors: [{ messageId: "forbidden" }],
        },
      ],
    });
  });

  // --- Critical 3 -----------------------------------------------------
  // "Inside packages/db" was a bare substring test on the filename, so any
  // path that merely *contains* the segment — e.g. a file nested inside a
  // different workspace package that happens to have its own "packages/db"
  // subdirectory — was wrongly treated as exempt.
  it("does not exempt a path that merely contains a packages/db segment", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import postgres from "postgres";`, filename: "/repo/packages/db/src/client.ts" },
        { code: `import postgres from "postgres";`, filename: "C:\\repo\\packages\\db\\src\\client.ts" },
      ],
      invalid: [
        {
          code: `import postgres from "postgres";`,
          filename: "/repo/apps/other-app/packages/db/sneaky.ts",
          errors: [{ messageId: "forbidden" }],
        },
        {
          code: `import postgres from "postgres";`,
          filename: "C:\\repo\\apps\\other-app\\packages\\db\\sneaky.ts",
          errors: [{ messageId: "forbidden" }],
        },
      ],
    });
  });

  // --- Critical 4 -----------------------------------------------------
  // The forbidden module list was an exact match, so any subpath beneath a
  // forbidden module (e.g. reaching into `drizzle-orm/postgres-js`'s
  // internals directly) went undetected.
  it("reports a subpath beneath a forbidden module", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import { drizzle } from "drizzle-orm/postgres-js";`, filename: "/repo/packages/db/src/client.ts" },
      ],
      invalid: [
        {
          code: `import { PgSession } from "drizzle-orm/postgres-js/session";`,
          filename: "/repo/apps/web/lib/x.ts",
          errors: [{ messageId: "forbidden" }],
        },
        {
          code: `import { something } from "drizzle-orm/pglite/foo";`,
          filename: "C:\\repo\\apps\\web\\lib\\x.ts",
          errors: [{ messageId: "forbidden" }],
        },
      ],
    });
  });

  // --- Important 5 -----------------------------------------------------
  // `@electric-sql/pglite` — the driver `packages/db/src/testing.ts` uses
  // for the in-memory test database — was missing from the forbidden list
  // entirely, so importing it directly from outside packages/db went
  // unflagged.
  it("reports a direct import of the PGlite driver", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import { PGlite } from "@electric-sql/pglite";`, filename: "/repo/packages/db/src/testing.ts" },
      ],
      invalid: [
        {
          code: `import { PGlite } from "@electric-sql/pglite";`,
          filename: "/repo/apps/web/lib/x.ts",
          errors: [{ messageId: "forbidden" }],
        },
      ],
    });
  });

  // --- Blocker C1 / Bypass 1 -------------------------------------------
  // A namespace import of the package entry (`import * as pfdb from
  // "@pentefino/db"`) never produces an `ImportSpecifier` or
  // `ExportSpecifier`, so the named-export check skipped it entirely: the
  // whole module — `getUnscopedDb`, `schema`, everything — came in bound to
  // one name.
  it("reports a namespace import of the package entry", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import * as pfdb from "@pentefino/db";`, filename: "/repo/packages/db/src/some-internal-file.ts" },
        { code: `import { withUser } from "@pentefino/db";`, filename: "/repo/apps/web/lib/invoices.ts" },
      ],
      invalid: [
        {
          // The exact reproduction from the audit.
          code: `import * as pfdb from "@pentefino/db";\npfdb.getUnscopedDb();`,
          filename: "/repo/apps/web/lib/invoices.ts",
          errors: [{ messageId: "forbiddenNamespace" }],
        },
        {
          code: `import * as pfdb from "@pentefino/db";`,
          filename: "C:\\repo\\apps\\web\\lib\\invoices.ts",
          errors: [{ messageId: "forbiddenNamespace" }],
        },
      ],
    });
  });

  // --- Blocker C1 / Bypass 2 -------------------------------------------
  // `packages/db/src/index.ts` used to re-export every table as a named
  // export of the package entry (`export * from "./schema.js"`), and the
  // rule only ever blocked the fixed names `getUnscopedDb` and `schema` —
  // so `import { invoices, events } from "@pentefino/db"` sailed through
  // both the package (it really was exported) and the rule (neither name
  // was on its list). The fix is two-layered: `index.ts` no longer
  // re-exports the tables at all (only the `schema` namespace object does,
  // and that name is already blocked), and the rule itself switched from a
  // blacklist to an allowlist, so a table name is rejected on its own
  // merits rather than by the package happening not to export it. This
  // keeps the rule correct even if a future change re-introduces the
  // re-export, and it is what lets this exact bypass be expressed as a
  // RuleTester case at all — the rule has no module resolution and cannot
  // otherwise know what `@pentefino/db` does or does not export.
  it("reports a named import of a table straight off the package entry", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        { code: `import { withUser } from "@pentefino/db";`, filename: "/repo/apps/web/lib/invoices.ts" },
        {
          code: `import { Database, Session, ScopedDb } from "@pentefino/db";`,
          filename: "/repo/apps/web/lib/invoices.ts",
        },
        {
          // The exemption for files inside packages/db applies here too.
          code: `import { invoices, events } from "@pentefino/db";`,
          filename: "C:\\repo\\packages\\db\\src\\some-internal-file.ts",
        },
      ],
      invalid: [
        {
          // The exact reproduction from the audit.
          code: `import { invoices, events } from "@pentefino/db";`,
          filename: "/repo/apps/web/lib/invoices.ts",
          errors: [{ messageId: "forbiddenExport" }, { messageId: "forbiddenExport" }],
        },
        {
          code: `import { invoices } from "@pentefino/db";`,
          filename: "C:\\repo\\apps\\web\\lib\\invoices.ts",
          errors: [{ messageId: "forbiddenExport" }],
        },
        {
          code: `export { invoices } from "@pentefino/db";`,
          filename: "/repo/apps/web/lib/reexport.ts",
          errors: [{ messageId: "forbiddenExport" }],
        },
      ],
    });
  });

  // --- Blocker C1 / Bypass 3 -------------------------------------------
  // `@pentefino/db/testing` (`createTestDb`) hands back a live, unscoped
  // PGlite database. It is in neither the forbidden-module list nor the
  // package-entry allowlist check, because it is not the package entry at
  // all — it is a subpath, and subpaths were never inspected by any check.
  // A real test file legitimately needs it (there is no other way to stand
  // up the in-memory test database); production code never does. The
  // exemption is deliberately keyed on *both* a `test`/`tests` directory
  // segment *and* a `.test.`/`.spec.` filename — see `isTestFile`'s own
  // comment — specifically so a production file cannot spoof its way past
  // the gate merely by being named to look like a test.
  it("reports an import of a @pentefino/db subpath from outside a test file", () => {
    tester.run("require-with-user", requireWithUser, {
      valid: [
        {
          code: `import { createTestDb } from "@pentefino/db/testing";`,
          filename: "/repo/apps/web/test/routes/invoices-report.test.ts",
        },
        {
          code: `import { createTestDb } from "@pentefino/db/testing";`,
          filename: "C:\\repo\\apps\\jobs\\test\\ingest.test.ts",
        },
        {
          code: `import { createTestDb } from "@pentefino/db/testing";`,
          filename: "/repo/apps/web/test/routes/invoices-report.spec.ts",
        },
        // The exemption for files inside packages/db applies here too.
        { code: `import { createTestDb } from "@pentefino/db/testing";`, filename: "/repo/packages/db/src/x.ts" },
      ],
      invalid: [
        {
          // The exact reproduction from the audit.
          code: `import { createTestDb } from "@pentefino/db/testing";`,
          filename: "/repo/apps/web/lib/invoices.ts",
          errors: [{ messageId: "forbiddenSubpath" }],
        },
        {
          // Named like a test, but not under a test/ directory — a
          // production file cannot buy its way past the gate by renaming
          // itself.
          code: `import { createTestDb } from "@pentefino/db/testing";`,
          filename: "/repo/apps/web/lib/invoices.test.ts",
          errors: [{ messageId: "forbiddenSubpath" }],
        },
        {
          // Under a test/ directory, but not itself a test file — a shared
          // helper does not inherit the exemption just from its location.
          code: `import { createTestDb } from "@pentefino/db/testing";`,
          filename: "/repo/apps/web/test/helpers/leaky.ts",
          errors: [{ messageId: "forbiddenSubpath" }],
        },
        {
          code: `import { createTestDb } from "@pentefino/db/testing";`,
          filename: "C:\\repo\\apps\\web\\lib\\invoices.ts",
          errors: [{ messageId: "forbiddenSubpath" }],
        },
      ],
    });
  });
});
