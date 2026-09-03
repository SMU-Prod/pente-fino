// Composition root for @pentefino/adapters. Each port declared in
// @pentefino/core/ports gets exactly one adapter factory exported here, and
// buildAdapters() below picks which implementation backs each port from the
// environment.

import { join } from "node:path";
import { EXTRACT_PROMPT_V1 } from "@pentefino/ai";
import type { AiProvider, Mailer, Storage, TaskQueue } from "@pentefino/core/ports";
import { createFixtureAiProvider } from "./ai/fixture.js";
import { createGatewayAiProvider } from "./ai/gateway.js";
import { createLocalMailer } from "./mailer/local.js";
import { createInProcessQueue, type TaskHandler } from "./queue/in-process.js";
import { createLocalStorage } from "./storage/local.js";

export { createLocalStorage, DOWNLOAD_TTL_MS } from "./storage/local.js";
export { createInProcessQueue, type TaskHandler } from "./queue/in-process.js";
export { createFixtureAiProvider } from "./ai/fixture.js";
export { createGatewayAiProvider } from "./ai/gateway.js";
export { createLocalMailer } from "./mailer/local.js";
export { createUnpdfReader } from "./reader/unpdf.js";

export type Adapters = { storage: Storage; queue: TaskQueue; ai: AiProvider; mailer: Mailer };

// Real-adapter env vars that don't have a real implementation yet, keyed by
// which port they belong to. Checked one at a time - rather than combined
// behind a single `||` - so the thrown error can name the exact variable
// that is set instead of leaving a developer to guess which of three
// unrelated keys triggered it.
//
// AI_GATEWAY_API_KEY is deliberately absent from this list (E1, Task 7):
// `createGatewayAiProvider` is a real adapter now, selected below.
const UNIMPLEMENTED_REAL_ADAPTER_ENV: Record<string, string> = {
  R2_ACCESS_KEY_ID: "storage (R2)",
  TRIGGER_SECRET_KEY: "queue (Trigger.dev)",
  RESEND_API_KEY: "mailer (Resend)",
};

/**
 * Chooses an implementation per port from the environment. Adding a real
 * adapter later means adding a branch here - no domain code changes.
 *
 * A real credential present with no real adapter to back it is a
 * half-configured state that must not reach production silently: this
 * throws, naming the exact offending variable, rather than quietly falling
 * back to the local adapter as if nothing were configured.
 */
export function buildAdapters(
  env: NodeJS.ProcessEnv,
  handlers: Record<string, TaskHandler> = {},
  fixtures: Record<string, unknown> = {},
): Adapters {
  for (const [varName, port] of Object.entries(UNIMPLEMENTED_REAL_ADAPTER_ENV)) {
    if (env[varName]) {
      throw new Error(
        `${varName} is set, but no real ${port} adapter is implemented yet. ` +
          `That arrives with E1/E5; unset ${varName} to keep using the local adapters.`,
      );
    }
  }

  const dataRoot = env.LOCAL_DATA_ROOT ?? join(process.cwd(), ".data");

  // With the key, the real AI Gateway provider; without it, the fixture -
  // never both, and never a silent fallback to the fixture when the key IS
  // present but something else about it is wrong (that stays a loud error
  // from the provider itself, on the first real call).
  const ai: AiProvider = env.AI_GATEWAY_API_KEY
    ? createGatewayAiProvider({
        apiKey: env.AI_GATEWAY_API_KEY,
        model: env.AI_GATEWAY_MODEL ?? EXTRACT_PROMPT_V1.modelDefault,
        visionModel: env.AI_GATEWAY_VISION_MODEL ?? EXTRACT_PROMPT_V1.modelDefault,
      })
    : createFixtureAiProvider(fixtures);

  return {
    storage: createLocalStorage({
      root: join(dataRoot, "blobs"),
      secret: env.UPLOAD_SIGNING_SECRET ?? "dev-only-secret",
    }),
    queue: createInProcessQueue(handlers),
    ai,
    mailer: createLocalMailer(join(dataRoot, "mail")),
  };
}
