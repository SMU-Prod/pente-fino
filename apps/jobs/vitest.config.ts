import { defineConfig, mergeConfig } from "vitest/config";
import { base } from "@pentefino/config/vitest.base";

export default mergeConfig(base, defineConfig({ test: { include: ["test/**/*.test.ts"] } }));
