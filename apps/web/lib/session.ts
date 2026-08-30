import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "pf_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, RF-140

// Only ever reached outside production, and only when SESSION_SIGNING_SECRET
// is unset. A production deploy with no real secret must fail loudly instead
// of quietly signing every visitor's session with a value checked into this
// repository - a known signing secret lets an attacker forge any other
// visitor's session cookie and read (or, on the report route, dismiss) their
// invoice. A crash on boot is a strictly better failure mode than a silently
// forgeable cookie in production.
const DEV_ONLY_FALLBACK_SECRET = "dev-only-secret-do-not-use-in-production";

export type SessionSecretEnv = { NODE_ENV?: string; SESSION_SIGNING_SECRET?: string };

export function getSessionSecret(env: SessionSecretEnv = process.env): string {
  const configured = env.SESSION_SIGNING_SECRET;
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SIGNING_SECRET is not set. Refusing to sign session cookies with a placeholder " +
        "secret in production - that would let anyone forge another visitor's session cookie.",
    );
  }
  return DEV_ONLY_FALLBACK_SECRET;
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signSession(sessionId: string, secret: string): string {
  if (!sessionId) throw new Error("signSession requires a non-empty sessionId");
  return `${sessionId}.${sign(sessionId, secret)}`;
}

export function readSession(cookieValue: string, secret: string): string | null {
  const index = cookieValue.lastIndexOf(".");
  if (index <= 0) return null; // no separator, or an empty sessionId before it
  const sessionId = cookieValue.slice(0, index);
  const provided = cookieValue.slice(index + 1);
  const expected = sign(sessionId, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}
