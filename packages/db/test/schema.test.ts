import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { invoices, issuers, users } from "../src/schema.js";

let ctx: TestDb;

beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

describe("schema", () => {
  it("applies every migration, pg_trgm included", async () => {
    const rows = await ctx.db.execute("select extname from pg_extension where extname = 'pg_trgm'");
    expect(rows.rows).toHaveLength(1);
  });

  it("stores and reads a user", async () => {
    const id = newId("usr");
    await ctx.db.insert(users).values({ id, email: "a@b.com" });
    const found = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(found[0]?.plan).toBe("free");
  });

  it("refuses a plan outside the check constraint", async () => {
    await expect(
      ctx.db.insert(users).values({ id: newId("usr"), email: "c@d.com", plan: "gold" }),
    ).rejects.toThrow();
  });

  it("accepts 'validating', the status §9.2 requires", async () => {
    const issuerId = newId("iss");
    await ctx.db.insert(issuers).values({
      id: issuerId, slug: "claro-movel", category: "telecom", displayName: "Claro Móvel",
    });
    const invoiceId = newId("inv");
    await expect(
      ctx.db.insert(invoices).values({
        id: invoiceId, issuerId, contentHash: "abc",
        source: "pdf_text", status: "validating",
      }),
    ).resolves.toBeTruthy();
  });

  it("enforces one invoice per owner and content hash", async () => {
    const userId = newId("usr");
    await ctx.db.insert(users).values({ id: userId, email: "e@f.com" });
    const row = { userId, contentHash: "same", source: "pdf_text" as const };
    await ctx.db.insert(invoices).values({ id: newId("inv"), ...row });
    await expect(
      ctx.db.insert(invoices).values({ id: newId("inv"), ...row }),
    ).rejects.toThrow();
  });
});
