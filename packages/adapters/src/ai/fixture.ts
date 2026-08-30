import { InvoiceCanonical } from "@pentefino/core";
import type { AiProvider } from "@pentefino/core/ports";

/**
 * Returns pre-recorded canonical invoices for local development and tests,
 * without ever calling a real model. Every fixture is parsed through the
 * very same Zod schema the real provider will validate its output with
 * (A7), so a fixture that would not pass validation in production does not
 * pass it here either. A file key with no matching fixture fails loudly
 * instead of inventing an invoice (A8). It always reports zero cost, so the
 * ai_calls ledger never mistakes a fixture run for a paid one.
 */
export function createFixtureAiProvider(fixtures: Record<string, unknown>): AiProvider {
  return {
    async extractInvoice({ fileKey }) {
      const fixture = fixtures[fileKey];
      if (fixture === undefined) {
        throw new Error(`no extraction fixture registered for file key "${fileKey}"`);
      }

      const canonical = InvoiceCanonical.parse(fixture);

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
