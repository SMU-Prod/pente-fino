import { CONTEST_PROMPT_V1, EXTRACT_PROMPT_V1 } from "@pentefino/ai";
import { newId } from "@pentefino/core";
import { prompts } from "../schema.js";
import type { Database } from "../client.js";

/**
 * Debt from E0: the design (A5, "configuração viva") says every prompt
 * lives in the `prompts` table as an active, versioned row — never as a
 * bare constant baked into the extractor's call site — but nothing ever
 * seeded the v1 extraction prompt. This closes that gap.
 *
 * `CONTEST_PROMPT_V1` (E4 Task 2) is seeded the same way: one row per
 * versioned prompt constant declared in `@pentefino/ai`, each independently
 * upserted by its own `(slug, version)` so seeding one never depends on, or
 * is blocked by, the other.
 */
export async function seedPrompts(db: Database): Promise<void> {
  for (const prompt of [EXTRACT_PROMPT_V1, CONTEST_PROMPT_V1]) {
    await db
      .insert(prompts)
      .values({
        id: newId("prm"),
        slug: prompt.slug,
        version: prompt.version,
        body: prompt.body,
        modelDefault: prompt.modelDefault,
        status: "active",
      })
      .onConflictDoNothing({ target: [prompts.slug, prompts.version] });
  }
}
