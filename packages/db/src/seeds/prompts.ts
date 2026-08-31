import { EXTRACT_PROMPT_V1 } from "@pentefino/ai";
import { newId } from "@pentefino/core";
import { prompts } from "../schema.js";
import type { Database } from "../client.js";

/**
 * Debt from E0: the design (A5, "configuração viva") says every prompt
 * lives in the `prompts` table as an active, versioned row — never as a
 * bare constant baked into the extractor's call site — but nothing ever
 * seeded the v1 extraction prompt. This closes that gap.
 */
export async function seedPrompts(db: Database): Promise<void> {
  await db
    .insert(prompts)
    .values({
      id: newId("prm"),
      slug: EXTRACT_PROMPT_V1.slug,
      version: EXTRACT_PROMPT_V1.version,
      body: EXTRACT_PROMPT_V1.body,
      modelDefault: EXTRACT_PROMPT_V1.modelDefault,
      status: "active",
    })
    .onConflictDoNothing({ target: [prompts.slug, prompts.version] });
}
