import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { rules } from "../../src/schema.js";

/**
 * The three dead theses of RN-090..092. No rule under active observation may
 * carry one of these slugs, or a renamed variant of one.
 */
const DEAD_THESES = ["icms-tusd-tust", "cosip-sem-poste", "agua-tarifa-minima-economia"];

/**
 * Rule statuses under active observation. `active` is the obvious one — it
 * is what the user sees. `shadow` must be included too: RF-125 evaluates a
 * `shadow` rule against real invoices for seven days, writing real
 * `findings` rows with `shadow = true`, and RF-126 lets it auto-promote to
 * `active` with no human sign-off once it clears a firing threshold. A dead
 * thesis sitting in `shadow` is therefore already being computed — just not
 * yet displayed — for its whole observation window, and a check that only
 * looked at `active` would miss it for all seven of those days and one
 * automatic promotion away from being shown to users.
 */
const OBSERVED_STATUSES = ["active", "shadow"];

/**
 * Separator-insensitive and version-suffix-insensitive slug comparison. Exact
 * string matching lets a dead thesis walk back in under a cosmetically
 * different slug — `icms-tusd-tust-v2` (a fake "new version") or
 * `icms_tusd_tust` (underscores instead of dashes) both mean the same
 * RN-090 thesis and must be caught the same as the original slug.
 */
function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[-_]/g, "").replace(/v\d+$/i, "");
}

const DEAD_THESES_NORMALIZED = DEAD_THESES.map(normalizeSlug);

function isDeadThesis(slug: string): boolean {
  return DEAD_THESES_NORMALIZED.includes(normalizeSlug(slug));
}

let ctx: TestDb;
let ruleSeq = 0;

beforeEach(async () => {
  ctx = await createTestDb();
  ruleSeq = 0;
});
afterEach(async () => { await ctx.close(); });

/** Inserts a minimal rule row under the given slug/status, for the probes below. */
async function insertRule(slug: string, status: string): Promise<void> {
  ruleSeq += 1;
  await ctx.db.insert(rules).values({
    id: `rul_probe_${ruleSeq}`,
    slug,
    category: "energy",
    kind: "pattern",
    spec: { kind: "pattern", match: "test" },
    confidenceBase: 0.5,
    status,
    author: "system",
    reason: "test probe",
  });
}

/** The slugs of every active-or-shadow rule that resolve to a dead thesis. */
async function observedDeadThesisSlugs(): Promise<string[]> {
  const observed = await ctx.db.select().from(rules).where(inArray(rules.status, OBSERVED_STATUSES));
  return observed.map((r) => r.slug).filter(isDeadThesis);
}

describe("INV-010 · the dead theses are never signalled", () => {
  it("finds no active or shadow rule carrying a dead thesis slug", async () => {
    expect(await observedDeadThesisSlugs()).toEqual([]);
  });

  it("keeps the dead thesis list wired to RN-090..092", () => {
    expect(DEAD_THESES).toHaveLength(3);
  });

  // Demonstrates the normalisation is load-bearing, not decorative: a dead
  // thesis reintroduced under a version-suffixed slug is still caught.
  it("catches a dead thesis reintroduced with a version suffix (icms-tusd-tust-v2)", async () => {
    await insertRule("icms-tusd-tust-v2", "active");
    expect(await observedDeadThesisSlugs()).toEqual(["icms-tusd-tust-v2"]);
  });

  // Demonstrates the same for a dead thesis reintroduced with underscores
  // instead of dashes — and in `shadow`, not `active`, so this also exercises
  // the widened status filter above in the same assertion.
  it("catches a dead thesis reintroduced with underscores instead of dashes (icms_tusd_tust)", async () => {
    await insertRule("icms_tusd_tust", "shadow");
    expect(await observedDeadThesisSlugs()).toEqual(["icms_tusd_tust"]);
  });
});
