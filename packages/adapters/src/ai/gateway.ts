import { createGateway, generateObject } from "ai";
import { InvoiceCanonical } from "@pentefino/core";
import type { AiProvider, ExtractInput } from "@pentefino/core/ports";

/**
 * The narrow slice of what a real `generateObject` call (from `ai`) needs
 * and returns - not the full, much larger `ai` types. Kept separate on
 * purpose: it is the seam a test injects a canned response through, and a
 * test has no business constructing the SDK's real, heavily-generic
 * `GenerateObjectResult<T>` just to stand in for a network call this suite
 * never makes (see the module doc comment on `createGatewayAiProvider`).
 */
export type ModelCallInput = {
  model: unknown;
  system: string;
  /** Text mode: the reader's own pages, joined into one prompt. */
  prompt?: string;
  /** Vision mode: the file itself, as a user message. */
  messages?: Array<{
    role: "user";
    content: Array<
      | { type: "text"; text: string }
      | { type: "file"; data: Uint8Array; mediaType: string }
    >;
  }>;
};

export type ModelCallResult = {
  object: unknown;
  usage: {
    // `| undefined` in addition to `?:` on purpose: the real `ai` package's
    // `LanguageModelUsage.inputTokens`/`outputTokens` are *required* keys
    // whose value can itself be `undefined`, which `exactOptionalPropertyTypes`
    // treats as distinct from an absent key - only the wider form here
    // accepts both that shape and the plain injected-test object literal
    // that simply omits the key.
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
  };
  /**
   * `providerMetadata.gateway.cost` is the AI Gateway's own reported cost
   * for this exact call, in USD - the Gateway meters and bills by the
   * token, so this is a real, per-call number rather than one this adapter
   * would otherwise have to guess from a locally-maintained price table
   * (which drifts silently the moment a vendor changes pricing). See
   * `extractInvoice` below for what happens when it is absent.
   */
  providerMetadata?: {
    gateway?: {
      cost?: unknown;
    };
  } | undefined;
};

/**
 * The model call itself, as an injectable seam. Production code's default
 * is the real `generateObject` from `ai`; tests supply a stand-in that
 * returns a canned `ModelCallResult` instead, so the suite proves this
 * adapter's own logic - schema validation, usage/cost extraction, mode
 * routing - without a network call and without mocking `fetch`.
 */
export type GenerateObjectFn = (input: ModelCallInput) => Promise<ModelCallResult>;

export type GatewayAiProviderConfig = {
  apiKey: string;
  /** Model id for `mode: "text"`, e.g. "anthropic/claude-sonnet-5". */
  model: string;
  /** Model id for `mode: "vision"`. */
  visionModel: string;
  /** Overrides the model call; see `GenerateObjectFn`'s doc comment. */
  generateObjectFn?: GenerateObjectFn;
};

const PROVIDER_NAME = "gateway";

const defaultGenerateObject: GenerateObjectFn = async ({ model, system, prompt, messages }) => {
  return generateObject({
    // `ModelCallInput.model` only exists to keep this function's own type
    // narrow for the injection seam above; the real `generateObject`
    // expects its own `LanguageModel` type, which is exactly what
    // `createGateway(...)(...)` below actually produces. This cast is the
    // single point of contact between this adapter's types and `ai`'s.
    model: model as Parameters<typeof generateObject>[0]["model"],
    schema: InvoiceCanonical,
    system,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(messages !== undefined ? { messages: messages as never } : {}),
  });
};

/**
 * The real `AiProvider` (A7/A8/§15.3), routed through the Vercel AI
 * Gateway so a plain "provider/model" id
 * (`EXTRACT_PROMPT_V1.modelDefault`) is enough - the Gateway itself
 * resolves which vendor actually serves the call, and `AI_GATEWAY_API_KEY`
 * is the one credential this adapter needs.
 *
 * A5 tension, resolved here: the prompt body is the caller's job to load
 * from the `prompts` table and hand over via `ExtractInput.promptBody` (see
 * the doc comment on that port type). This adapter has no database
 * dependency at all - it only ever sees the string it is given, and never
 * imports `@pentefino/db`. Reaching into the table itself would couple an
 * AI vendor integration to a persistence choice that has nothing to do
 * with it, and would make this adapter's own tests need a real (or PGlite)
 * database just to prove "the prompt body is included in the request" -
 * exactly the network-shaped test this task explicitly rules out for the
 * model call itself.
 */
export function createGatewayAiProvider(config: GatewayAiProviderConfig): AiProvider {
  const { apiKey, model, visionModel, generateObjectFn = defaultGenerateObject } = config;
  const gatewayProvider = createGateway({ apiKey });
  const languageModel = {
    text: gatewayProvider(model),
    vision: gatewayProvider(visionModel),
  };

  return {
    async extractInvoice(input: ExtractInput) {
      const modelId = input.mode === "vision" ? visionModel : model;
      const startedAt = Date.now();

      let result: ModelCallResult;
      try {
        let modeInput: Pick<ModelCallInput, "prompt" | "messages">;
        if (input.mode === "text") {
          modeInput = { prompt: (input.pages ?? []).join("\n\n---\n\n") };
        } else {
          if (!input.file) {
            // A contract violation from the caller (ExtractInput says
            // `file` is present whenever mode is "vision"), not something a
            // real model call could ever hit - caught below and reported
            // clearly rather than as a cryptic property-access crash.
            throw new Error(`mode "vision" requires ExtractInput.file, but none was given for "${input.fileKey}"`);
          }
          modeInput = {
            messages: [{
              role: "user" as const,
              content: [{ type: "file" as const, data: input.file.bytes, mediaType: input.file.mimeType }],
            }],
          };
        }

        result = await generateObjectFn({
          model: languageModel[input.mode],
          system: input.promptBody,
          ...modeInput,
        });
      } catch (error) {
        // A8: a refusal, a timeout, or a transport error all become one
        // clear, actionable message here - never a half-empty invoice.
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `AI extraction failed for "${input.fileKey}" using ${modelId} (${input.mode}): ${cause}`,
          { cause: error },
        );
      }

      const latencyMs = Date.now() - startedAt;

      // A7: `generateObject`'s own `schema` option already validates the
      // real SDK's response structurally before it ever gets here. Parsing
      // again is what makes that guarantee testable without a network -
      // the injected `generateObjectFn` above returns a plain object that
      // never passed through any schema at all - and is cheap, honest
      // defense in depth in production against a future refactor that
      // forwards `result.object` unchecked.
      const canonical = InvoiceCanonical.parse(result.object);

      const costUsd = result.providerMetadata?.gateway?.cost;
      if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) {
        // §15.3: the cost-out-of-curve alert is blind to a call that
        // silently reports zero. Refusing loudly instead of defaulting to
        // 0 is the same A8 principle already applied to invoice content,
        // applied here to cost.
        throw new Error(
          `AI Gateway response for "${input.fileKey}" carried no usable cost metadata ` +
          "(expected a number at providerMetadata.gateway.cost); refusing to record a " +
          "fabricated $0 in ai_calls (PRD §15.3).",
        );
      }

      return {
        canonical,
        usage: {
          tokensIn: result.usage.inputTokens ?? 0,
          tokensOut: result.usage.outputTokens ?? 0,
          costUsd,
          latencyMs,
          model: modelId,
          provider: PROVIDER_NAME,
        },
      };
    },
  };
}
