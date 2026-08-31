import { InvoiceCanonical } from "@pentefino/core";
import type { AiProvider } from "@pentefino/core/ports";

/**
 * Returns pre-recorded canonical invoices for local development and tests,
 * without ever calling a real model. Every fixture is parsed through the
 * very same Zod schema the real provider will validate its output with
 * (A7), so a fixture that would not pass validation in production does not
 * pass it here either. A file key with no matching fixture fails loudly
 * instead of inventing an invoice (A8). Lookup is gated on key presence,
 * not on the looked-up value: a fixture explicitly registered as
 * `undefined` is a different situation from an unregistered key, and must
 * fail Zod validation loudly rather than being reported as "no fixture".
 * It always reports zero cost, so the ai_calls ledger never mistakes a
 * fixture run for a paid one.
 *
 * `mode`, `pages`, `file` and `promptBody` - what the classify stage decided
 * (RF-107) and what the caller resolved from the `prompts` table (A5) - are
 * deliberately not consulted here: a fixture stands in for whatever a real
 * provider would have produced for this exact file, regardless of which
 * route got it there or which prompt version asked, so lookup stays keyed
 * on `fileKey` alone.
 */
export function createFixtureAiProvider(fixtures: Record<string, unknown>): AiProvider {
  return {
    async extractInvoice({ fileKey }) {
      if (!(fileKey in fixtures)) {
        throw new Error(`no extraction fixture registered for file key "${fileKey}"`);
      }

      const canonical = InvoiceCanonical.parse(fixtures[fileKey]);

      return {
        canonical,
        usage: {
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: 0,
          model: "fixture",
          provider: "fixture",
        },
      };
    },
  };
}
