import type { InvoiceCanonical } from "../invoice/canonical.js";

export type AiUsage = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  provider: string;
};

/**
 * What the classify stage (RF-107) decided before a model is ever asked
 * anything: `mode` carries the route `extractionQuality` picked, and
 * `pages` carries the transcription the reader already produced - present
 * only for `mode: "text"`, since vision sends the file itself rather than
 * text pulled from it.
 */
export type ExtractInput = {
  fileKey: string;
  promptVersion: number;
  /** RF-107's route. Text extraction sends the transcription; vision sends the file. */
  mode: "text" | "vision";
  /** Present when mode is "text": the pages unpdf read, in order. */
  pages?: string[];
};

export type AiProvider = {
  extractInvoice(input: ExtractInput): Promise<{ canonical: InvoiceCanonical; usage: AiUsage }>;
};
