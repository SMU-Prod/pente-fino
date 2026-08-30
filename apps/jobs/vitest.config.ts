import { defineConfig, mergeConfig } from "vitest/config";
import { base } from "@pentefino/config/vitest.base";

// `test/**/*.spec.ts` picks up §16.3's invariant suites
// (`test/invariants/*.spec.ts`); `apps/*` configs used to omit it while every
// `packages/*` config already carried it, so a suite added here would
// silently never run (finding 7).
export default mergeConfig(base, defineConfig({
  test: { include: ["test/**/*.test.ts", "test/**/*.spec.ts"] },
}));
