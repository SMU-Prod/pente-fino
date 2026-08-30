import type { InvoiceCanonical } from "../invoice/canonical.js";

export type AiUsage = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  provider: string;
};

export type AiProvider = {
  extractInvoice(input: {
    fileKey: string;
    promptVersion: number;
  }): Promise<{ canonical: InvoiceCanonical; usage: AiUsage }>;
};
