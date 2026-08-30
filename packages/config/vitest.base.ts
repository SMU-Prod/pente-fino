import { defineConfig } from "vitest/config";

export const base = defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "json-summary"] },
  },
});
