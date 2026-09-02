import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../src/testing.js";
import { schema } from "../src/index.js";
import { seedAll, seedIssuers } from "../src/seeds/index.js";

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

describe("seeds", () => {
  it("creates the six telecom issuers of PRD §20.1", async () => {
    await seedIssuers(ctx.db);
    const rows = await ctx.db.select().from(schema.issuers);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.slug).sort()).toEqual(
      ["algar", "claro-movel", "oi", "sky", "tim-movel", "vivo-movel"],
    );
  });

  it("gives every seeded issuer the telecom category and active status", async () => {
    await seedIssuers(ctx.db);
    const rows = await ctx.db.select().from(schema.issuers);
    expect(rows.every((r) => r.category === "telecom")).toBe(true);
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  it("carries the aliases issuer detection needs", async () => {
    await seedIssuers(ctx.db);
    const [claro] = await ctx.db.select().from(schema.issuers)
      .where(eq(schema.issuers.slug, "claro-movel"));
    expect(claro?.aliases).toContain("Claro");
  });

  it("is idempotent, so a redeploy does not duplicate", async () => {
    await seedIssuers(ctx.db);
    await seedIssuers(ctx.db);
    expect(await ctx.db.select().from(schema.issuers)).toHaveLength(6);
  });

  it("seeds the v1 extraction prompt as an active row (A5)", async () => {
    await seedAll(ctx.db);
    const rows = await ctx.db.select().from(schema.prompts);
    // Two versioned prompts exist as of E4 Task 2 (extract, contest) — see
    // the "seeds the v1 contest prompt" test below for the other one. Found
    // by slug rather than assumed row order/position, since nothing here
    // guarantees the insertion order `seedPrompts` used is also the order
    // a plain, unordered `select()` returns them in.
    const extract = rows.find((r) => r.slug === "extract");
    expect(extract?.version).toBe(1);
    expect(extract?.status).toBe("active");
  });

  it("seeds the v1 contest prompt as an active row (A5, E4 Task 2)", async () => {
    await seedAll(ctx.db);
    const rows = await ctx.db.select().from(schema.prompts);
    const contest = rows.find((r) => r.slug === "contest");
    expect(contest?.version).toBe(1);
    expect(contest?.status).toBe("active");
  });

  it("is idempotent for prompts too, so a redeploy does not duplicate either versioned row", async () => {
    await seedAll(ctx.db);
    await seedAll(ctx.db);
    const rows = await ctx.db.select().from(schema.prompts);
    expect(rows).toHaveLength(2);
  });

  it("seeds the extraction prompt body verbatim from PRD §20.3", async () => {
    await seedAll(ctx.db);
    const [prompt] = await ctx.db.select().from(schema.prompts).where(eq(schema.prompts.slug, "extract"));
    expect(prompt?.body).toContain("Não interprete. Não classifique.");
  });

  it("seeds the contest prompt body instructing first-person authorship, never a legal citation (INV-003/RF-161)", async () => {
    await seedAll(ctx.db);
    const [prompt] = await ctx.db.select().from(schema.prompts).where(eq(schema.prompts.slug, "contest"));
    expect(prompt?.body).toContain("Não cite lei");
    expect(prompt?.body).toContain("primeira pessoa");
  });
});
