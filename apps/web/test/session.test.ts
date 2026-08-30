import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getSessionSecret, readSession, signSession } from "../lib/session.js";

const secret = "test-secret";

describe("anonymous session cookie (ADR-07)", () => {
  it("round trips a session id", () => {
    const cookie = signSession("ses_abc", secret);
    expect(readSession(cookie, secret)).toBe("ses_abc");
  });

  it("rejects a tampered cookie", () => {
    const cookie = signSession("ses_abc", secret);
    expect(readSession(cookie.replace("ses_abc", "ses_xyz"), secret)).toBeNull();
  });

  it("rejects a cookie signed with another secret", () => {
    expect(readSession(signSession("ses_abc", "other"), secret)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(readSession("garbage", secret)).toBeNull();
  });

  it("rejects an empty session id even when the signature is otherwise valid", () => {
    // Built by hand, bypassing signSession's own guard against signing an
    // empty id, so this pins readSession's own defense independently of it.
    const sigOfEmptyString = createHmac("sha256", secret).update("").digest("base64url");
    expect(readSession(`.${sigOfEmptyString}`, secret)).toBeNull();
  });

  it("refuses to sign an empty session id", () => {
    expect(() => signSession("", secret)).toThrow();
  });
});

describe("getSessionSecret (production must never fall back to a placeholder)", () => {
  // Every case below passes its own env object explicitly rather than
  // mutating process.env - getSessionSecret takes the env as a parameter
  // specifically so this doesn't need to touch (and restore) global state.

  it("throws in production when SESSION_SIGNING_SECRET is not set", () => {
    expect(() => getSessionSecret({ NODE_ENV: "production" })).toThrow(/SESSION_SIGNING_SECRET/);
  });

  it("throws in production when SESSION_SIGNING_SECRET is set to an empty string", () => {
    expect(() => getSessionSecret({ NODE_ENV: "production", SESSION_SIGNING_SECRET: "" })).toThrow();
  });

  it("returns the configured secret in production when it is set", () => {
    expect(getSessionSecret({ NODE_ENV: "production", SESSION_SIGNING_SECRET: "real-secret" }))
      .toBe("real-secret");
  });

  it("falls back to a dev-only secret outside production when none is configured", () => {
    expect(getSessionSecret({ NODE_ENV: "test" })).toBeTruthy();
    expect(getSessionSecret({ NODE_ENV: "test" })).toBe(getSessionSecret({ NODE_ENV: "development" }));
  });

  it("prefers a configured secret over the dev fallback outside production too", () => {
    expect(getSessionSecret({ NODE_ENV: "test", SESSION_SIGNING_SECRET: "custom" })).toBe("custom");
  });
});
