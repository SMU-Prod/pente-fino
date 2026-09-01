import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { base } from "@pentefino/config/vitest.base";

// Mirrors tsconfig.json's "@/*" -> "./*" path alias (Next.js reads that one
// itself; Vite/Vitest do not, so route files under test that import
// "@/lib/..." need this to resolve the same way `next build`'s webpack does.
export default mergeConfig(base, defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // apps/web's tsconfig sets "jsx": "preserve" because Next's own SWC
  // compiler does the real JSX transform at build time - tsc never runs
  // one. Vitest's esbuild transform has no such downstream compiler behind
  // it, so it needs its own jsx setting; "automatic" matches the runtime
  // React 19/Next 15 actually use (no `import React` needed in a .tsx
  // file), so a component under test behaves the same way here as it does
  // under `next build`.
  esbuild: { jsx: "automatic" },
  // `test/**/*.spec.ts` picks up §16.3's invariant suites
  // (`test/invariants/*.spec.ts`); `apps/*` configs used to omit it while
  // every `packages/*` config already carried it, so a suite added here
  // would silently never run (finding 7).
  test: { include: ["test/**/*.test.ts", "test/**/*.spec.ts"] },
}));
