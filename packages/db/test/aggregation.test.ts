import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { anonymousSessions, invoices, users } from "../src/schema.js";
import { invoicesEligibleForAggregation } from "../src/aggregation.js";

let ctx: TestDb;

beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

// RF-245's acceptance ("sem consentimento, a fatura não alimenta
// `aggregates`") pinned against the three shapes an invoice's owner can
// take: a user who said yes, a user who never did (or took it back), and no
// user at all. Only the first may ever come back.
describe("invoicesEligibleForAggregation", () => {
  it("returns only the consenting user's invoice, excluding the non-consenting user's and the anonymous session's", async () => {
    const consenting = newId("usr");
    const nonConsenting = newId("usr");
    const sessionId = newId("ses");

    await ctx.db.insert(users).values([
      { id: consenting, email: "consenting@example.com", aggregateConsentAt: new Date() },
      { id: nonConsenting, email: "non-consenting@example.com" },
    ]);
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });

    const consentingInvoiceId = newId("inv");
    const nonConsentingInvoiceId = newId("inv");
    const anonymousInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values([
      { id: consentingInvoiceId, userId: consenting, contentHash: "agg-yes", source: "pdf_text" },
      { id: nonConsentingInvoiceId, userId: nonConsenting, contentHash: "agg-no", source: "pdf_text" },
      { id: anonymousInvoiceId, sessionId, contentHash: "agg-anon", source: "pdf_text" },
    ]);

    const eligible = await invoicesEligibleForAggregation(ctx.db);

    expect(eligible.map((invoice) => invoice.id)).toEqual([consentingInvoiceId]);
  });

  it("stops seeing an invoice the moment its owner withdraws consent", async () => {
    const userId = newId("usr");
    await ctx.db.insert(users).values({ id: userId, email: "withdrawn@example.com", aggregateConsentAt: new Date() });
    const invoiceId = newId("inv");
    await ctx.db.insert(invoices).values({ id: invoiceId, userId, contentHash: "agg-withdraw", source: "pdf_text" });

    expect(await invoicesEligibleForAggregation(ctx.db)).toHaveLength(1);

    await ctx.db.update(users).set({ aggregateConsentAt: null }).where(eq(users.id, userId));

    expect(await invoicesEligibleForAggregation(ctx.db)).toHaveLength(0);
  });

  it("returns an empty list when nobody has consented", async () => {
    const userId = newId("usr");
    await ctx.db.insert(users).values({ id: userId, email: "nobody@example.com" });
    await ctx.db.insert(invoices).values({ id: newId("inv"), userId, contentHash: "agg-none", source: "pdf_text" });

    expect(await invoicesEligibleForAggregation(ctx.db)).toEqual([]);
  });
});
