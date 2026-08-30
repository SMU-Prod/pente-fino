/**
 * INV-008 — no module outside @pentefino/db may reach the raw database
 * client. User data is read through withUser(), which carries the
 * ownership filter.
 */
/** @type {import("eslint").Rule.RuleModule} */
export const requireWithUser = {
  meta: {
    type: "problem",
    docs: { description: "forbid importing the raw db client outside @pentefino/db" },
    messages: {
      forbidden: "Import withUser from @pentefino/db instead of the raw client (INV-008).",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const insideDbPackage = filename.replace(/\\/g, "/").includes("/packages/db/");
    const FORBIDDEN = ["drizzle-orm/postgres-js", "drizzle-orm/pglite", "postgres"];
    return {
      ImportDeclaration(node) {
        if (insideDbPackage) return;
        if (FORBIDDEN.includes(node.source.value)) {
          context.report({ node, messageId: "forbidden" });
        }
      },
    };
  },
};
