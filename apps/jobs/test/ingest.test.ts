import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { newId, type InvoiceCanonical } from "@pentefino/core";
import { createFixtureAiProvider, createLocalStorage } from "@pentefino/adapters";
import { createTestDb, type TestDb } from "@pentefino/db/testing";
import { events, invoiceItems, invoices, issuers } from "@pentefino/db";
import { createIngestTask } from "../src/tasks/ingest.js";

const canonical = {
  issuer: { name: "Claro Móvel", cnpj: "40432544000147", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [{
    name: "Serviços",
    items: [
      { description: "Plano pós-pago", amountCents: 9000 },
      { description: "Titular CPF 123.456.789-09", amountCents: 1000 },
    ],
  }],
  extraction: { confidence: 0.95, warnings: [] },
} as InvoiceCanonical;

let ctx: TestDb;
let root: string;
let issuerId: string;
let invoiceId: string;
const fileKey = "uploads/abc.pdf";

// The ingest task must not even ask the AI provider about a file that was
// never actually uploaded (A8): it checks `storage` first. Writing the bytes
// straight to disk - instead of going through `signUpload`/`put` - is
// deliberate: those two enforce a real content-hash match against the
// invoice's `contentHash`, and the fixture invoices below use a placeholder
// hash ("abc") that is not the real digest of anything. Only the resulting
// file's presence on disk is under test here, not the upload contract.
function seedStorageObject(key: string, body = "fake pdf bytes") {
  const target = join(root, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

beforeEach(async () => {
  ctx = await createTestDb();
  root = mkdtempSync(join(tmpdir(), "pf-job-"));
  seedStorageObject(fileKey);

  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({
    id: issuerId, slug: "claro-movel", category: "telecom", displayName: "Claro Móvel",
  });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, issuerId, contentHash: "abc", source: "pdf_text",
    status: "queued", fileKey,
  });
});

afterEach(async () => {
  await ctx.close();
  rmSync(root, { recursive: true, force: true });
});

function task() {
  return createIngestTask({
    db: ctx.db,
    storage: createLocalStorage({ root, secret: "s" }),
    ai: createFixtureAiProvider({ [fileKey]: canonical }),
  });
}

describe("ingest task", () => {
  it("takes the invoice to analyzed", async () => {
    await task()({ invoiceId });
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("analyzed");
  });

  it("writes the items", async () => {
    await task()({ invoiceId });
    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(2);
  });

  it("stores the normalised description alongside the original", async () => {
    await task()({ invoiceId });
    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    const plan = items.find((i) => i.description.startsWith("Plano"));
    expect(plan?.normalizedDesc).toBe("PLANO POS PAGO");
  });

  it("persists a masked canonical, never the CPF (INV-007)", async () => {
    await task()({ invoiceId });
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(JSON.stringify(row?.canonical)).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(row?.masked).toBe(true);
  });

  it("records the pipeline events in order (A3)", async () => {
    await task()({ invoiceId });
    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    expect(rows.map((r) => r.type)).toContain("invoice_extracted");
  });

  it("records an event when the invoice reaches analyzed, so the outcome is readable from events alone (A3)", async () => {
    await task()({ invoiceId });
    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    expect(rows.map((r) => r.type)).toContain("invoice_analyzed");
  });

  it("writes an ai_calls row for the extraction", async () => {
    await task()({ invoiceId });
    const rows = await ctx.db.query.aiCalls.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe("extract");
  });

  it("produces no findings, because no rule is active", async () => {
    await task()({ invoiceId });
    const rows = await ctx.db.query.findings.findMany();
    expect(rows).toEqual([]);
  });

  it("sends an invoice that fails validation to needs_review (RF-108)", async () => {
    const broken = { ...canonical, totalCents: 99999 } as InvoiceCanonical;
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      ai: createFixtureAiProvider({ [fileKey]: broken }),
    });
    await failing({ invoiceId });
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("needs_review");
  });

  it("does not write invoice_items when validation fails, because masking never runs on a rejected invoice", async () => {
    const broken = { ...canonical, totalCents: 99999 } as InvoiceCanonical;
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      ai: createFixtureAiProvider({ [fileKey]: broken }),
    });
    await failing({ invoiceId });
    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(0);
  });

  it("is idempotent: running twice does not duplicate items (A4)", async () => {
    await task()({ invoiceId });
    await task()({ invoiceId });
    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(2);
  });

  it("does not re-run ai extraction for an invoice already analyzed (A4)", async () => {
    await task()({ invoiceId });
    await task()({ invoiceId });
    const rows = await ctx.db.query.aiCalls.findMany();
    expect(rows).toHaveLength(1);
  });

  it("preserves invoice_item ids across a re-run from an intermediate state, so foreign keys pointing at items survive (A4)", async () => {
    await task()({ invoiceId });
    const before = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    const idsBefore = before.map((i) => i.id).sort();
    expect(idsBefore).toHaveLength(2);

    // Simulate a crash that left the invoice mid-pipeline - never reaching
    // `analyzed` - instead of touching the rows a prior attempt may already
    // have written. A delete-then-reinsert strategy would mint fresh ids
    // here and, in a world with findings, cascade-delete anything already
    // pointed at the old ones.
    await ctx.db.update(invoices).set({ status: "validating" }).where(eq(invoices.id, invoiceId));

    await task()({ invoiceId });
    const after = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.id).sort()).toEqual(idsBefore);
  });

  it("throws when the invoice row does not exist, instead of inventing one (A8)", async () => {
    const missingId = newId("inv");
    await expect(task()({ invoiceId: missingId })).rejects.toThrow(/not found/);
  });

  it("marks the invoice failed and records an event when extraction throws (A8)", async () => {
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      ai: createFixtureAiProvider({}), // no fixture registered for fileKey
    });

    await expect(failing({ invoiceId })).rejects.toThrow();

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("failed");
    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    expect(rows.map((r) => r.type)).toContain("invoice_failed");
  });

  it("does not write an ai_calls row when extraction throws before returning usage", async () => {
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      ai: createFixtureAiProvider({}),
    });
    await expect(failing({ invoiceId })).rejects.toThrow();
    const rows = await ctx.db.query.aiCalls.findMany();
    expect(rows).toEqual([]);
  });

  it("marks the invoice failed without calling the AI provider when the storage object is missing (A8)", async () => {
    const orphanId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: orphanId, issuerId, contentHash: "zzz", source: "pdf_text",
      status: "queued", fileKey: "uploads/zzz.pdf", // never written to disk
    });

    let called = false;
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      ai: { async extractInvoice() { called = true; throw new Error("must not be called"); } },
    });

    await expect(failing({ invoiceId: orphanId })).rejects.toThrow(/storage|missing/i);
    expect(called).toBe(false);

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, orphanId));
    expect(row?.status).toBe("failed");
    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, orphanId));
    expect(rows.map((r) => r.type)).toContain("invoice_failed");
  });
});
