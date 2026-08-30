import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { rules } from "../../src/schema.js";

/** The three dead theses of RN-090..092. No active rule may signal them. */
const DEAD_THESES = ["icms-tusd-tust", "cosip-sem-poste", "agua-tarifa-minima-economia"];

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

describe("INV-010 · the dead theses are never signalled", () => {
  it("finds no active rule carrying a dead thesis slug", async () => {
    const active = await ctx.db.select().from(rules).where(eq(rules.status, "active"));
    const offenders = active.filter((r) => DEAD_THESES.includes(r.slug));
    expect(offenders).toEqual([]);
  });

  it("keeps the dead thesis list wired to RN-090..092", () => {
    expect(DEAD_THESES).toHaveLength(3);
  });
});
