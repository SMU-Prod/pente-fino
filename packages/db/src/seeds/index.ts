import type { Database } from "../client.js";
import { seedIssuers } from "./issuers.js";
import { seedPrompts } from "./prompts.js";
import { seedDeterministicRules } from "./rules/deterministic.js";
import { seedLexiconRules } from "./rules/lexicon.js";

export { seedIssuers } from "./issuers.js";
export { seedPrompts } from "./prompts.js";
export { seedDeterministicRules } from "./rules/deterministic.js";
export { seedLexiconRules } from "./rules/lexicon.js";

/**
 * Runs every seed. Called after migrations wherever a database should look
 * like production — `createTestDb` (every test) and, eventually, a real
 * deploy/ops seeding step.
 */
export async function seedAll(db: Database): Promise<void> {
  await seedIssuers(db);
  await seedPrompts(db);
  await seedDeterministicRules(db);
  await seedLexiconRules(db);
}
