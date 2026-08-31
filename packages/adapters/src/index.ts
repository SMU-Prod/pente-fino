// Composition root for @pentefino/adapters. Each port declared in
// @pentefino/core/ports gets exactly one adapter factory exported here, and
// buildAdapters() below picks which implementation backs each port from the
// environment.

import { join } from "node:path";
import type { AiProvider, Mailer, Storage, TaskQueue } from "@pentefino/core/ports";
import { createFixtureAiProvider } from "./ai/fixture.js";
import { createLocalMailer } from "./mailer/local.js";
import { createInProcessQueue, type TaskHandler } from "./queue/in-process.js";
import { createLocalStorage } from "./storage/local.js";

export { createLocalStorage } from "./storage/local.js";
export { createInProcessQueue, type TaskHandler } from "./queue/in-process.js";
export { createFixtureAiProvider } from "./ai/fixture.js";
export { createLocalMailer } from "./mailer/local.js";
export { createUnpdfReader } from "./reader/unpdf.js";

export type Adapters = { storage: Storage; queue: TaskQueue; ai: AiProvider; mailer: Mailer };

// Real-adapter env vars that don't have a real implementation yet, keyed by
// which port they belong to. Checked one at a time - rather than combined
// behind a single `||` - so the thrown error can name the exact variable
// that is set instead of leaving a developer to guess which of three
// unrelated keys triggered it.
const UNIMPLEMENTED_REAL_ADAPTER_ENV: Record<string, string> = {
  R2_ACCESS_KEY_ID: "storage (R2)",
  TRIGGER_SECRET_KEY: "queue (Trigger.dev)",
  AI_GATEWAY_API_KEY: "ai (AI Gateway)",
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

  return {
    storage: createLocalStorage({
      root: join(dataRoot, "blobs"),
      secret: env.UPLOAD_SIGNING_SECRET ?? "dev-only-secret",
    }),
    queue: createInProcessQueue(handlers),
    ai: createFixtureAiProvider(fixtures),
    mailer: createLocalMailer(join(dataRoot, "mail")),
  };
}
