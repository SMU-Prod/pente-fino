import { defineConfig, mergeConfig } from "vitest/config";
import { base } from "@pentefino/config/vitest.base";

export default mergeConfig(base, defineConfig({
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts", "test/**/*.spec.ts"] },
}));
