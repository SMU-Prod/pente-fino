import { describe, expect, it } from "vitest";
import { lintUserFacingText } from "@pentefino/ai";
import { getClaimCodeSecret, renderClaimCodeEmail } from "../lib/claim.js";

describe("getClaimCodeSecret (production must never fall back to a placeholder)", () => {
  // Same shape as session.test.ts's getSessionSecret suite - each case
  // passes its own env object rather than mutating process.env.

  it("throws in production when CLAIM_CODE_SECRET is not set", () => {
    expect(() => getClaimCodeSecret({ NODE_ENV: "production" })).toThrow(/CLAIM_CODE_SECRET/);
  });

  it("throws in production when CLAIM_CODE_SECRET is set to an empty string", () => {
    expect(() => getClaimCodeSecret({ NODE_ENV: "production", CLAIM_CODE_SECRET: "" })).toThrow();
  });

  it("returns the configured secret in production when it is set", () => {
    expect(getClaimCodeSecret({ NODE_ENV: "production", CLAIM_CODE_SECRET: "real-secret" })).toBe("real-secret");
  });

  it("falls back to a dev-only secret outside production when none is configured", () => {
    expect(getClaimCodeSecret({ NODE_ENV: "test" })).toBeTruthy();
    expect(getClaimCodeSecret({ NODE_ENV: "test" })).toBe(getClaimCodeSecret({ NODE_ENV: "development" }));
  });

  it("prefers a configured secret over the dev fallback outside production too", () => {
    expect(getClaimCodeSecret({ NODE_ENV: "test", CLAIM_CODE_SECRET: "custom" })).toBe("custom");
  });

  it("uses a different fallback than getSessionSecret, so the two never share key material by accident", async () => {
    const { getSessionSecret } = await import("../lib/session.js");
    expect(getClaimCodeSecret({ NODE_ENV: "test" })).not.toBe(getSessionSecret({ NODE_ENV: "test" }));
  });
});

describe("renderClaimCodeEmail", () => {
  it("includes the exact code and passes INV-004/INV-005's lint", () => {
    const body = renderClaimCodeEmail("042857");
    expect(body).toContain("042857");
    expect(lintUserFacingText(body).ok).toBe(true);
  });

  it("mentions the code's lifetime in minutes", () => {
    expect(renderClaimCodeEmail("123456")).toMatch(/\d+ minutos/);
  });
});
