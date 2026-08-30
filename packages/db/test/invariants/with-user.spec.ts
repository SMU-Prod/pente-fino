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
});
