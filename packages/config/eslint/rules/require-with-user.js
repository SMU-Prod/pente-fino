/**
 * INV-008 — no module outside @pentefino/db may reach the raw database
 * client or the raw table definitions. User data is read through
 * withUser(), which carries the ownership filter.
 *
 * Two independent escape hatches are checked, both scoped to files outside
 * the real `packages/db` workspace package:
 *
 *   1. A named import of `getUnscopedDb` or `schema` from this package's own
 *      public entry point, `@pentefino/db` (static import or re-export).
 *      Those two exports hand out the raw client and the raw table
 *      definitions respectively; anything that needs them belongs inside
 *      `packages/db`.
 *   2. Any reach into a forbidden raw driver module — `postgres`,
 *      `drizzle-orm/postgres-js`, `drizzle-orm/pglite`, or
 *      `@electric-sql/pglite` — or any subpath beneath one, via static
 *      `import`, dynamic `import()`, `require()`, or a re-export
 *      (`export { x } from "..."`, `export * from "..."`).
 *
 * A legitimate unscoped caller (a background job with no user session, say)
 * can still get past the gate, but only visibly: it silences a single
 * occurrence with `// eslint-disable-next-line pentefino/require-with-user`
 * and a reason on the same line. There is no path allowlist here on
 * purpose — an allowlist hides the exception from review and from grep; a
 * disable comment does not.
 */

const FORBIDDEN_MODULES = [
  "drizzle-orm/postgres-js",
  "drizzle-orm/pglite",
  "@electric-sql/pglite",
  "postgres",
];

const RAW_PACKAGE_EXPORTS = new Set(["getUnscopedDb", "schema"]);

const PACKAGE_ENTRY = "@pentefino/db";

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
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const insideDbPackage = isInsideDbPackage(filename);

    function checkModuleSource(node, moduleName) {
      if (insideDbPackage) return;
      if (typeof moduleName === "string" && isForbiddenModule(moduleName)) {
        context.report({ node, messageId: "forbidden" });
      }
    }

    function checkNamedSpecifiers(specifiers, moduleName) {
      if (insideDbPackage || moduleName !== PACKAGE_ENTRY || !specifiers) return;
      for (const specifier of specifiers) {
        let sourceName;
        if (specifier.type === "ImportSpecifier") sourceName = nameOf(specifier.imported);
        else if (specifier.type === "ExportSpecifier") sourceName = nameOf(specifier.local);
        else continue;

        if (sourceName && RAW_PACKAGE_EXPORTS.has(sourceName)) {
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
