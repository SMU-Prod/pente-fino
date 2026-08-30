import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { anonymousSessions, invoices } from "../src/schema.js";
import { ensureAnonymousSession, withUser } from "../src/with-user.js";

let ctx: TestDb;

beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

describe("ensureAnonymousSession", () => {
  it("creates the anonymous_sessions row for a brand-new session id", async () => {
    const sessionId = newId("ses");
    const expiresAt = new Date(Date.now() + 60_000);
    await ensureAnonymousSession(sessionId, expiresAt, ctx.db);

    const [row] = await ctx.db.select().from(anonymousSessions).where(eq(anonymousSessions.id, sessionId));
    expect(row?.id).toBe(sessionId);
  });

  it("is idempotent: a second call for the same id does not throw or duplicate the row", async () => {
    const sessionId = newId("ses");
    const expiresAt = new Date(Date.now() + 60_000);
    await ensureAnonymousSession(sessionId, expiresAt, ctx.db);
    await expect(ensureAnonymousSession(sessionId, new Date(Date.now() + 999_000), ctx.db)).resolves.not.toThrow();

    const rows = await ctx.db.select().from(anonymousSessions).where(eq(anonymousSessions.id, sessionId));
    expect(rows).toHaveLength(1);
  });

  // This is the load-bearing reason the helper exists: `invoices.session_id`
  // carries a real foreign key to `anonymous_sessions.id`. Without a row
  // there first, inserting the very first invoice for a brand-new anonymous
  // visitor fails at the database level.
  it("satisfies the invoices.session_id foreign key, so a fresh session can immediately own an invoice", async () => {
    const sessionId = newId("ses");
    await ensureAnonymousSession(sessionId, new Date(Date.now() + 60_000), ctx.db);

    const scoped = withUser({ sessionId }, ctx.db);
    const invoiceId = await scoped.insertInvoice({ contentHash: "h1", source: "pdf_text" });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.sessionId).toBe(sessionId);
  });
});
