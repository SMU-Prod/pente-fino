import { defineConfig, mergeConfig } from "vitest/config";
import { base } from "@pentefino/config/vitest.base";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.spec.ts"],
    coverage: {
      // RNF-15. The floor is enforced here so CI cannot drift below it.
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/**/*.ts"],
      // Colocated test files match `src/**/*.ts` too. Left in, they count
      // as 100%-covered-by-construction lines in the denominator and
      // inflate the reported number well above what the *implementation*
      // actually reaches (finding 6) - a real gap in mask.ts or validate.ts
      // could hide behind a healthy-looking aggregate figure.
      exclude: ["src/index.ts", "src/ports/**", "src/**/*.test.ts"],
    },
  },
}));
