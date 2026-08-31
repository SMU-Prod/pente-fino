import { describe, expect, it, vi } from "vitest";
import type { InvoiceCanonical } from "@pentefino/core";
import { EXTRACT_PROMPT_V1 } from "@pentefino/ai";
import { createGatewayAiProvider, type GenerateObjectFn } from "./gateway.js";

const validCanonical = {
  issuer: { name: "Claro Móvel", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
  extraction: { confidence: 0.95, warnings: [] },
} as InvoiceCanonical;

const BASE_CONFIG = {
  apiKey: "test-key",
  model: "anthropic/claude-sonnet-5",
  visionModel: "anthropic/claude-sonnet-5",
};

const TEXT_INPUT = {
  fileKey: "uploads/text.pdf",
  promptVersion: 1,
  promptBody: EXTRACT_PROMPT_V1.body,
  mode: "text" as const,
  pages: ["fatura Claro Móvel página 1", "detalhamento página 2"],
};

const VISION_INPUT = {
  fileKey: "uploads/scan.pdf",
  promptVersion: 1,
  promptBody: EXTRACT_PROMPT_V1.body,
  mode: "vision" as const,
  file: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf" },
};

function okResult(overrides: Partial<Awaited<ReturnType<GenerateObjectFn>>> = {}) {
  return {
    object: validCanonical,
    usage: { inputTokens: 1200, outputTokens: 340 },
    providerMetadata: { gateway: { cost: 0.0041 } },
    ...overrides,
  };
}

describe("gateway ai provider", () => {
  it("validates a well-formed model response through InvoiceCanonical and returns it (A7)", async () => {
    const generateObjectFn: GenerateObjectFn = vi.fn(async () => okResult());
    const ai = createGatewayAiProvider({ ...BASE_CONFIG, generateObjectFn });

    const { canonical } = await ai.extractInvoice(TEXT_INPUT);

    expect(canonical.issuer.name).toBe("Claro Móvel");
    expect(canonical.totalCents).toBe(10000);
  });

  it("raises rather than passing through a response the schema rejects (A7)", async () => {
    const broken = { ...validCanonical, totalCents: -5 } as InvoiceCanonical;
    const generateObjectFn: GenerateObjectFn = vi.fn(async () => okResult({ object: broken }));
    const ai = createGatewayAiProvider({ ...BASE_CONFIG, generateObjectFn });

    await expect(ai.extractInvoice(TEXT_INPUT)).rejects.toThrow();
  });

  it("surfaces a model refusal as a clear, actionable error rather than an empty invoice (A8)", async () => {
    const generateObjectFn: GenerateObjectFn = vi.fn(async () => {
      throw new Error("the model declined to produce structured output: content policy");
    });
    const ai = createGatewayAiProvider({ ...BASE_CONFIG, generateObjectFn });

    await expect(ai.extractInvoice(TEXT_INPUT)).rejects.toThrow(/declined|refus/i);
  });

  it("reports usage from the real response, not a hard-coded figure", async () => {
    const generateObjectFn: GenerateObjectFn = vi.fn(async () => okResult({
      usage: { inputTokens: 4321, outputTokens: 987 },
      providerMetadata: { gateway: { cost: 0.0123 } },
    }));
    const ai = createGatewayAiProvider({ ...BASE_CONFIG, generateObjectFn });

    const { usage } = await ai.extractInvoice(TEXT_INPUT);

    expect(usage.tokensIn).toBe(4321);
    expect(usage.tokensOut).toBe(987);
    expect(usage.costUsd).toBe(0.0123);
    expect(usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(usage.provider).toBe("gateway");
    expect(usage.model).toBe(BASE_CONFIG.model);
  });

  it("refuses to report a fabricated zero cost when the response carries no cost metadata (§15.3)", async () => {
    const generateObjectFn: GenerateObjectFn = vi.fn(async () => ({
      object: validCanonical,
      usage: { inputTokens: 10, outputTokens: 10 },
    }));
    const ai = createGatewayAiProvider({ ...BASE_CONFIG, generateObjectFn });

    await expect(ai.extractInvoice(TEXT_INPUT)).rejects.toThrow(/cost/i);
  });

  it("sends the reader's pages as the prompt for text mode, and the file's own bytes for vision mode - materially different requests", async () => {
    const calls: Array<Parameters<GenerateObjectFn>[0]> = [];
    const generateObjectFn: GenerateObjectFn = vi.fn(async (input) => {
      calls.push(input);
      return okResult();
    });
    const ai = createGatewayAiProvider({ ...BASE_CONFIG, generateObjectFn });

    await ai.extractInvoice(TEXT_INPUT);
    await ai.extractInvoice(VISION_INPUT);

    const [textCall, visionCall] = calls;
    expect(textCall?.prompt).toContain("fatura Claro Móvel página 1");
    expect(textCall?.messages).toBeUndefined();

    expect(visionCall?.prompt).toBeUndefined();
    expect(visionCall?.messages).toBeDefined();
    const filePart = visionCall?.messages?.[0]?.content.find((part) => part.type === "file");
    expect(filePart).toMatchObject({ type: "file", mediaType: "application/pdf" });
    expect((filePart as { data: Uint8Array }).data).toBe(VISION_INPUT.file.bytes);
  });

  it("sends the exact prompt body it was given as the system message, never a literal baked into the adapter", async () => {
    const generateObjectFn: GenerateObjectFn = vi.fn(async () => okResult());
    const ai = createGatewayAiProvider({ ...BASE_CONFIG, generateObjectFn });

    await ai.extractInvoice(TEXT_INPUT);

    expect(generateObjectFn).toHaveBeenCalledWith(
      expect.objectContaining({ system: EXTRACT_PROMPT_V1.body }),
    );
  });

  it("uses the vision model for mode vision and the text model for mode text", async () => {
    const generateObjectFn: GenerateObjectFn = vi.fn(async () => okResult());
    const ai = createGatewayAiProvider({
      apiKey: "test-key",
      model: "anthropic/claude-haiku-5",
      visionModel: "anthropic/claude-sonnet-5",
      generateObjectFn,
    });

    const textResult = await ai.extractInvoice(TEXT_INPUT);
    const visionResult = await ai.extractInvoice(VISION_INPUT);

    expect(textResult.usage.model).toBe("anthropic/claude-haiku-5");
    expect(visionResult.usage.model).toBe("anthropic/claude-sonnet-5");
  });
});
