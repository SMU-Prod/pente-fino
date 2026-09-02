import { and, eq, isNull, sql } from "drizzle-orm";
import { TELECOM_PLAYBOOK_V1 } from "@pentefino/core";
import { issuers } from "../schema.js";
import type { Database } from "../client.js";

/**
 * Debt from E0, the twin of the one `prompts.ts` closes: `issuers.playbook`
 * is the `jsonb` column §7.4 types as a `Playbook`, and every seeded issuer
 * had `null` there. So no live issuer could produce a deadline (RF-181), no
 * stage had a channel name or a deep link to show (RF-183), and E4's
 * `assembleContest` — which is forbidden from inventing a legal reference —
 * had no seeded data to draw the stage's `asks` from.
 *
 * Seeded the same way a prompt is (A5, "configuração viva"): the versioned
 * constant lives in the package that owns the type (`@pentefino/core`), and
 * this file only writes it onto rows.
 *
 * **Only where the column is still null.** `prompts.ts` uses
 * `onConflictDoNothing` for the same reason: a seed run must never overwrite
 * configuration an operator has since tuned for one issuer. That makes this
 * idempotent — a redeploy is a no-op — at the cost that a revised §20.2 does
 * not propagate on its own. Moving an issuer to `TELECOM_PLAYBOOK_V2` will
 * be a deliberate act, not a side effect of deploying.
 *
 * **Telecom only**, because §20.2's playbook is telecom's: its channels are
 * Anatel and the operator's SAC, and its `legalRefs` are Anatel resolutions.
 * §20.1 seeds six telecom issuers and no card, energy or water issuer, so
 * nothing is left without a playbook today — but the first card issuer added
 * will need one of its own, including the `ombudsman` stage §9.1 routes a
 * card case to and §20.2 does not describe.
 */
export async function seedPlaybooks(db: Database): Promise<void> {
  await db
    .update(issuers)
    .set({ playbook: TELECOM_PLAYBOOK_V1, updatedAt: sql`now()` })
    .where(and(eq(issuers.category, "telecom"), isNull(issuers.playbook)));
}
