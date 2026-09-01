import { describe, expect, it } from "vitest";
import { arithmetic, pattern, threshold } from "./index.js";

// Task 4's engine dispatches by kind through this module, so its exports
// are the evaluators' real public surface - worth a smoke test of its own
// on top of each evaluator's dedicated test file.
describe("evaluators/index.ts", () => {
  it("re-exports the three evaluators built in this task", () => {
    expect(typeof pattern).toBe("function");
    expect(typeof threshold).toBe("function");
    expect(typeof arithmetic).toBe("function");
  });
});
