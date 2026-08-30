import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { base } from "@pentefino/config/vitest.base";

// Mirrors tsconfig.json's "@/*" -> "./*" path alias (Next.js reads that one
// itself; Vite/Vitest do not, so route files under test that import
// "@/lib/..." need this to resolve the same way `next build`'s webpack does.
export default mergeConfig(base, defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
}));
