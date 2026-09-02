import { describe, expect, it } from "vitest";
import { resolveNow } from "../src/clock.js";

describe("resolveNow", () => {
  it("falls back to the real clock when the payload carries no `now`", () => {
    const before = Date.now();
    const resolved = resolveNow({}, "some-task");
    expect(resolved.getTime()).toBeGreaterThanOrEqual(before);
    expect(resolved.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("passes a Date through unchanged", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(resolveNow({ now }, "some-task").getTime()).toBe(now.getTime());
  });

  it("accepts an ISO string, which is what a JSON queue payload can actually carry", () => {
    expect(resolveNow({ now: "2026-08-31T12:00:00.000Z" }, "some-task").toISOString())
      .toBe("2026-08-31T12:00:00.000Z");
  });

  it("accepts epoch millis", () => {
    expect(resolveNow({ now: 1_756_641_600_000 }, "some-task").getTime()).toBe(1_756_641_600_000);
  });

  it("names the task in the error, so a bad payload says which job rejected it", () => {
    expect(() => resolveNow({ now: { nested: true } }, "case-deadlines"))
      .toThrow(/^case-deadlines: payload\.now must be a Date, string or number, got object$/);
  });
});
