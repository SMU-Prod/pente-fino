import { CLAIM_CODE_TTL_MS } from "@pentefino/db";

// A dedicated secret, deliberately not SESSION_SIGNING_SECRET reused: the
// two HMACs protect different things (a long-lived session cookie vs. a
// short-lived, low-entropy numeric code) and giving them independent key
// material means rotating - or, worse, ever needing to reason about a leak
// of - one never has any bearing on the other.
const DEV_ONLY_FALLBACK_CLAIM_CODE_SECRET = "dev-only-claim-code-secret-do-not-use-in-production";

export type ClaimCodeSecretEnv = { NODE_ENV?: string; CLAIM_CODE_SECRET?: string };

/**
 * Mirrors getSessionSecret's shape exactly (lib/session.ts): a real secret
 * is required in production, and only in production - a placeholder there
 * would let anyone who obtains a database dump compute `codeHash` for any
 * guessed code offline (see packages/db/src/claim.ts's header comment) and
 * confirm someone else's claim.
 */
export function getClaimCodeSecret(env: ClaimCodeSecretEnv = process.env): string {
  const configured = env.CLAIM_CODE_SECRET;
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "CLAIM_CODE_SECRET is not set. Refusing to hash claim codes with a placeholder secret in " +
        "production - a database dump plus a known secret would let anyone compute the hash for a " +
        "guessed code and claim another person's invoices.",
    );
  }
  return DEV_ONLY_FALLBACK_CLAIM_CODE_SECRET;
}

const CLAIM_CODE_TTL_MINUTES = Math.round(CLAIM_CODE_TTL_MS / 60_000);

/**
 * pt-BR, checked against packages/ai's lintUserFacingText (INV-004/INV-005)
 * in test/claim.test.ts - no legal vocabulary, no promise of an outcome,
 * nothing this code's own confirmation doesn't already guarantee.
 */
export function renderClaimCodeEmail(code: string): string {
  return [
    `Seu código de verificação é ${code}.`,
    "",
    `Ele expira em ${CLAIM_CODE_TTL_MINUTES} minutos e vale só para essa confirmação.`,
    "",
    "Se você não pediu esse código, pode ignorar este e-mail com segurança.",
  ].join("\n");
}

export const CLAIM_CODE_EMAIL_SUBJECT = "Seu código de verificação";
