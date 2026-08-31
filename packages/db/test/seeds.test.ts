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
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("extract");
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.status).toBe("active");
  });

  it("seeds the prompt body verbatim from PRD §20.3", async () => {
    await seedAll(ctx.db);
    const [prompt] = await ctx.db.select().from(schema.prompts);
    expect(prompt?.body).toContain("Não interprete. Não classifique.");
  });
});
