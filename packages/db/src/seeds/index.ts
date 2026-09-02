import type { Database } from "../client.js";
import { seedIssuers } from "./issuers.js";
import { seedPlaybooks } from "./playbooks.js";
import { seedPrompts } from "./prompts.js";
import { seedDeterministicRules } from "./rules/deterministic.js";
import { seedSuppressorRules } from "./rules/suppressors.js";
import { seedLexiconRules } from "./rules/lexicon.js";

export { seedIssuers } from "./issuers.js";
export { seedPlaybooks } from "./playbooks.js";
export { seedPrompts } from "./prompts.js";
export { seedDeterministicRules } from "./rules/deterministic.js";
export { seedSuppressorRules } from "./rules/suppressors.js";
export { seedLexiconRules } from "./rules/lexicon.js";

/**
 * Runs every seed. Called after migrations wherever a database should look
 * like production — `createTestDb` (every test) and, eventually, a real
 * deploy/ops seeding step.
 */
export async function seedAll(db: Database): Promise<void> {
  await seedIssuers(db);
  // After `seedIssuers`: it is what inserts the rows this fills in.
  await seedPlaybooks(db);
  await seedPrompts(db);
  await seedDeterministicRules(db);
  await seedSuppressorRules(db);
  await seedLexiconRules(db);
}
