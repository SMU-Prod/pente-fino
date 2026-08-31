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
 *
 * `promptBody` is the active `prompts` row's own text for `promptVersion`
 * (A5: prompt bodies are versioned database rows, never a literal baked
 * into an adapter). The port carries the resolved body, not just the
 * version number, so that an `AiProvider` never needs a database dependency
 * of its own just to look up config its caller - which already owns a
 * `Database` handle - can resolve once and hand over. Coupling an AI
 * adapter to persistence would make "swap providers" and "swap where
 * config lives" two independent decisions collide into one file.
 */
export type ExtractInput = {
  fileKey: string;
  promptVersion: number;
  /** The `prompts` row's `body` for `promptVersion` - see the doc comment above. */
  promptBody: string;
  /** RF-107's route. Text extraction sends the transcription; vision sends the file. */
  mode: "text" | "vision";
  /** Present when mode is "text": the pages unpdf read, in order. */
  pages?: string[];
  /** Present when mode is "vision": the file's own bytes, sniffed mime type included. */
  file?: { bytes: Uint8Array; mimeType: string };
};

export type AiProvider = {
  extractInvoice(input: ExtractInput): Promise<{ canonical: InvoiceCanonical; usage: AiUsage }>;
};
