import { defineConfig, mergeConfig } from "vitest/config";
import { base } from "@pentefino/config/vitest.base";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.spec.ts"],
    coverage: {
      // RNF-15. The floor is enforced here so CI cannot drift below it.
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/ports/**"],
    },
  },
}));
