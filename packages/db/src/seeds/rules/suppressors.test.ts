import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { RULE_KINDS } from "@pentefino/core";
import { createTestDb, type TestDb } from "../../testing.js";
import { rules } from "../../schema.js";
import {
  SUPPRESSOR_RULES, seedSuppressorRules, RN_090, RN_091, RN_092,
} from "./suppressors.js";

const ALL_SLUGS = [RN_090, RN_091, RN_092];

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

async function suppressorRows() {
  return ctx.db.select().from(rules).where(inArray(rules.slug, ALL_SLUGS));
}

describe("seedSuppressorRules", () => {
  it("is already wired into seedAll: createTestDb's db has all three RN-090..092 suppressors", async () => {
    const rows = await suppressorRows();
    expect(rows.map((r) => r.slug).sort()).toEqual([...ALL_SLUGS].sort());
  });

  // The one deliberate exception to RF-125's "a new rule enters shadow"
  // convention (see the module doc comment on suppressors.ts): a suppressor
  // sitting in shadow suppresses nothing, so INV-010 would be violated for
  // as long as it stayed there.
  it("gives every suppressor active status, never draft/shadow/paused", async () => {
    const rows = await suppressorRows();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect(rows.every((r) => r.shadowUntil === null)).toBe(true);
  });

  it("keeps the kind column consistent with spec.kind, both equal to 'suppressor'", async () => {
    const rows = await suppressorRows();
    for (const row of rows) {
      expect(RULE_KINDS).toContain(row.kind);
      expect(row.kind).toBe("suppressor");
      expect(row.spec.kind).toBe("suppressor");
    }
  });

  it("gives every suppressor a non-empty spec.blocks and a non-empty spec.reason/reason", async () => {
    const rows = await suppressorRows();
    for (const row of rows) {
      const spec = row.spec as { kind: "suppressor"; blocks: string[]; reason: string };
      expect(spec.blocks.length).toBeGreaterThan(0);
      for (const source of spec.blocks) {
        expect(() => new RegExp(source)).not.toThrow();
      }
      expect(spec.reason.length).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(0);
    }
  });

  it("assigns each suppressor a category the checked catalogue actually uses", async () => {
    const rows = await suppressorRows();
    const byCategory = Object.fromEntries(rows.map((r) => [r.slug, r.category]));
    expect(byCategory[RN_090]).toBe("energy"); // ICMS sobre TUSD/TUST
    expect(byCategory[RN_091]).toBe("energy"); // COSIP
    expect(byCategory[RN_092]).toBe("water"); // tarifa mínima por economia
  });

  it("is generic, not issuer-specific (issuerId null)", async () => {
    const rows = await suppressorRows();
    expect(rows.every((r) => r.issuerId === null)).toBe(true);
  });

  it("is idempotent: seeding twice does not duplicate rows", async () => {
    await seedSuppressorRules(ctx.db);
    await seedSuppressorRules(ctx.db);
    expect(await suppressorRows()).toHaveLength(3);
  });

  it("refreshes content on reseed but leaves status alone, so a redeploy cannot silently pause a suppressor", async () => {
    await ctx.db.update(rules).set({ status: "paused" }).where(eq(rules.slug, RN_090));

    await seedSuppressorRules(ctx.db);

    const [paused] = await ctx.db.select().from(rules).where(eq(rules.slug, RN_090));
    expect(paused?.status).toBe("paused");
  });

  it("has exactly the three dead theses of §12.4, no more, no fewer", () => {
    expect(SUPPRESSOR_RULES).toHaveLength(3);
    expect(SUPPRESSOR_RULES.map((r) => r.slug).sort()).toEqual([...ALL_SLUGS].sort());
  });
});
