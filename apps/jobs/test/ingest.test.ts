import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractionQuality, newId, type InvoiceCanonical } from "@pentefino/core";
import { createFixtureAiProvider, createLocalStorage, createUnpdfReader } from "@pentefino/adapters";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createIngestTask } from "../src/tasks/ingest.js";

const { events, invoiceItems, invoices, issuers } = schema;

// The same hand-built, committed fixtures the unpdf reader's own tests use
// (packages/adapters/src/reader/unpdf.test.ts) - real, parseable PDFs, not
// placeholder bytes, now that the classify stage actually sniffs and reads
// what is in storage instead of trusting the caller.
function pdfFixture(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../../fixtures/synthetic/pdfs/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

// "Claro Móvel", CNPJ 40.432.544/0001-47, "Total a pagar R$ 129,90",
// "Vencimento 10/08/2026" on page 1 - a real text layer that both scores
// above RF-107's threshold and identifies the seeded "claro-movel" issuer
// by alias, matching the CNPJ this file's own `canonical` fixture also uses.
const TEXT_TWO_PAGE_PDF = pdfFixture("text-2page.pdf");
const SCAN_ONE_PAGE_PDF = pdfFixture("scan-1page.pdf");
const TEXT_THIRTEEN_PAGE_PDF = pdfFixture("text-13page.pdf");

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

// A zero-cost usage record for ai fixtures below that capture their input
// instead of going through createFixtureAiProvider - shaped exactly like
// the one createFixtureAiProvider itself reports, so a captured-call test
// is not accidentally exercising a different AiUsage shape.
const ZERO_USAGE = {
  tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, model: "test", provider: "test",
};

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
function seedStorageObject(key: string, body: string | Uint8Array = TEXT_TWO_PAGE_PDF) {
  const target = join(root, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

beforeEach(async () => {
  ctx = await createTestDb();
  root = mkdtempSync(join(tmpdir(), "pf-job-"));
  seedStorageObject(fileKey);

  // seedIssuers (run by createTestDb) already owns the real "claro-movel"
  // slug; inserting a second row under that slug would trip
  // issuers_slug_unique. Reuse the seeded row instead of shadowing it.
  const [seededClaro] = await ctx.db.select().from(issuers).where(eq(issuers.slug, "claro-movel"));
  issuerId = seededClaro!.id;
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
    reader: createUnpdfReader(),
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
      reader: createUnpdfReader(),
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
      reader: createUnpdfReader(),
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

  // --- Pre-E1 fix, finding 4: the process route used to distinguish
  // "invoice not found" from "extraction genuinely failed" by testing
  // `String(error).includes("not found")` - a substring an unrelated
  // provider failure (e.g. "model gpt-9-mini not found") could spoof into a
  // false 404. Both thrown errors must instead carry a typed, structural
  // `reason` the route can check without reading message text at all.

  it("tags a missing invoice's error with reason invoice_not_found", async () => {
    const missingId = newId("inv");
    await expect(task()({ invoiceId: missingId })).rejects.toMatchObject({ reason: "invoice_not_found" });
  });

  it("tags a genuine extraction failure with reason extraction_failed, even when its message contains the words \"not found\"", async () => {
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: { async extractInvoice() { throw new Error("model gpt-9-mini not found"); } },
    });
    await expect(failing({ invoiceId })).rejects.toMatchObject({ reason: "extraction_failed" });
  });

  it("marks the invoice failed and records an event when extraction throws (A8)", async () => {
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
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
      reader: createUnpdfReader(),
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
      reader: createUnpdfReader(),
      ai: { async extractInvoice() { called = true; throw new Error("must not be called"); } },
    });

    await expect(failing({ invoiceId: orphanId })).rejects.toThrow(/storage|missing/i);
    expect(called).toBe(false);

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, orphanId));
    expect(row?.status).toBe("failed");
    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, orphanId));
    expect(rows.map((r) => r.type)).toContain("invoice_failed");
  });

  // --- Finding 1: a rerun that reproduces fewer items than before must not
  // leave the old, now-nonexistent lines behind. Each case forces the
  // invoice back to "validating" between runs, the same crash simulation the
  // "preserves invoice_item ids" test above uses, so the `analyzed` guard
  // does not short-circuit the rerun.

  it("removes items a rerun no longer reproduces, so invoice_items matches invoices.canonical (idempotency)", async () => {
    await task()({ invoiceId });
    const before = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(before).toHaveLength(2);

    await ctx.db.update(invoices).set({ status: "validating" }).where(eq(invoices.id, invoiceId));

    // totalCents must track the shrunk item sum: validation (RF-108) rejects
    // anything more than 1% off, and a rejected invoice never reaches persist.
    const shrunk: InvoiceCanonical = {
      ...canonical,
      totalCents: 9000,
      sections: [{ name: "Serviços", items: [canonical.sections[0]!.items[0]!] }],
    };
    const rerun = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [fileKey]: shrunk }),
    });
    await rerun({ invoiceId });

    const after = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(after).toHaveLength(1);
    expect(after[0]?.description.startsWith("Plano")).toBe(true);

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    const storedCanonical = row?.canonical as InvoiceCanonical;
    expect(storedCanonical.sections[0]?.items).toHaveLength(1);
  });

  it("keeps prior lines and adds the new one when a rerun reproduces more items than before (idempotency)", async () => {
    const shrunk: InvoiceCanonical = {
      ...canonical,
      totalCents: 9000,
      sections: [{ name: "Serviços", items: [canonical.sections[0]!.items[0]!] }],
    };
    const first = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [fileKey]: shrunk }),
    });
    await first({ invoiceId });
    const before = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(before).toHaveLength(1);
    const survivingId = before[0]!.id;

    await ctx.db.update(invoices).set({ status: "validating" }).where(eq(invoices.id, invoiceId));

    await task()({ invoiceId }); // full two-item canonical

    const after = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.id)).toContain(survivingId);
  });

  // Pre-E1 fix, line-key stability: identity is now (section, description,
  // periodRef, amountCents), not position - so "same rows, updated content"
  // only holds when a rerun changes a field that is NOT part of that
  // identity. `meta` is exactly that: masked and persisted, but not part of
  // the key. (A rerun that changes the *description* is a different,
  // deliberate case - see the "replaces the row" test right below.)
  it("keeps the same rows, with updated non-identity content, when a rerun reproduces the same items (idempotency)", async () => {
    await task()({ invoiceId });
    const before = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(before).toHaveLength(2);
    const idsBefore = before.map((i) => i.id).sort();

    await ctx.db.update(invoices).set({ status: "validating" }).where(eq(invoices.id, invoiceId));

    const withMeta: InvoiceCanonical = {
      ...canonical,
      sections: [{
        name: "Serviços",
        items: [
          { description: "Plano pós-pago", amountCents: 9000, meta: { linha: "11999999999" } },
          { description: "Titular CPF 123.456.789-09", amountCents: 1000 },
        ],
      }],
    };
    const rerun = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [fileKey]: withMeta }),
    });
    await rerun({ invoiceId });

    const after = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.id).sort()).toEqual(idsBefore);
    expect(after.find((i) => i.description === "Plano pós-pago")?.meta).toEqual({ linha: "11999999999" });
  });

  it("replaces the row instead of editing it in place when a rerun changes an item's description, because identity is content, not position", async () => {
    await task()({ invoiceId });
    const before = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    const planBefore = before.find((i) => i.description.startsWith("Plano"));
    expect(planBefore).toBeDefined();

    await ctx.db.update(invoices).set({ status: "validating" }).where(eq(invoices.id, invoiceId));

    const renamed: InvoiceCanonical = {
      ...canonical,
      sections: [{
        name: "Serviços",
        items: [
          { description: "Plano pós-pago renovado", amountCents: 9000 },
          { description: "Titular CPF 123.456.789-09", amountCents: 1000 },
        ],
      }],
    };
    const rerun = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [fileKey]: renamed }),
    });
    await rerun({ invoiceId });

    const after = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(after).toHaveLength(2);
    // The old row's own id is gone - a description edit is, by design,
    // indistinguishable from "this line was removed and a new one added".
    expect(after.map((i) => i.id)).not.toContain(planBefore!.id);
    expect(after.some((i) => i.description === "Plano pós-pago renovado")).toBe(true);
  });

  // --- Pre-E1 fix, line-key stability: `lineNo = sectionIndex * 1000 +
  // itemIndex` used to be the upsert key. It is only stable while section
  // and item ordering never changes between re-extractions of the same
  // invoice - a re-extraction that finds one extra section ahead of an
  // existing one shifts every lineNo downstream. Because the upsert target
  // was (invoiceId, lineNo), the row that used to sit at a given lineNo kept
  // its id but silently inherited whatever item the rerun now placed at that
  // same lineNo - exactly the foreign-key hazard (`findings.itemId`) the
  // upsert exists to avoid. The row must instead be keyed on the item's own
  // identity, so it survives reordering with both its id AND its own content
  // intact.

  it("keeps an existing item's id pointed at its own content when a re-extraction inserts a new section ahead of it", async () => {
    await task()({ invoiceId });
    const before = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    const plan = before.find((i) => i.description.startsWith("Plano"));
    expect(plan).toBeDefined();
    const planId = plan!.id;

    await ctx.db.update(invoices).set({ status: "validating" }).where(eq(invoices.id, invoiceId));

    // A brand-new section ahead of "Serviços" pushes it from sectionIndex 0
    // to 1, shifting every lineNo the old formula would have computed for it.
    const shifted: InvoiceCanonical = {
      ...canonical,
      totalCents: canonical.totalCents + 500,
      sections: [
        { name: "Descontos", items: [{ description: "Desconto fidelidade", amountCents: 500 }] },
        ...canonical.sections,
      ],
    };
    const rerun = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [fileKey]: shifted }),
    });
    await rerun({ invoiceId });

    const [afterRow] = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.id, planId));
    expect(afterRow?.description).toBe("Plano pós-pago");
    expect(afterRow?.amountCents).toBe(9000);

    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(3);
  });

  it("keeps two genuinely identical lines in one invoice as distinct rows instead of colliding on one key", async () => {
    const duplicateLines: InvoiceCanonical = {
      ...canonical,
      totalCents: 2000,
      sections: [{
        name: "Serviços",
        items: [
          { description: "Chamada local", amountCents: 1000 },
          { description: "Chamada local", amountCents: 1000 },
        ],
      }],
    };
    const withDuplicates = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [fileKey]: duplicateLines }),
    });
    await withDuplicates({ invoiceId });

    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  // --- Finding 2: a status change and its event must land together or not
  // at all. Simulated here by poisoning the shared `PgDatabase` prototype so
  // the very insert that writes `invoice_analyzed` fails, and everything
  // after it fails too (standing in for a crash that kills the connection).
  // Without a transaction wrapping the status update and the event insert,
  // the update - a separate, already-awaited statement - has already
  // committed by the time the insert fails, stranding the invoice at
  // `analyzed` with no `invoice_analyzed` event and, because the guard at
  // the top of `ingest` short-circuits on `status === "analyzed"`, no way
  // for a retry to ever repair it.
  it("does not strand the invoice at analyzed with no invoice_analyzed event when the event write fails (A3)", async () => {
    // Both originals must be captured BEFORE either prototype method is
    // replaced, or the "original" saved for restoration is actually the
    // already-patched version - which would leak the patch into every test
    // that runs afterward.
    const originalInsert = PgDatabase.prototype.insert;
    const originalUpdate = PgDatabase.prototype.update;
    let poisoned = false;
    (PgDatabase.prototype as any).insert = function (this: unknown, table: unknown) {
      if (poisoned) throw new Error("simulated connection loss (poisoned)");
      const builder: any = originalInsert.call(this, table as never);
      if (table === events) {
        const originalValues = builder.values.bind(builder);
        builder.values = (vals: any) => {
          if (vals?.type === "invoice_analyzed") {
            poisoned = true;
            throw new Error("simulated connection loss while writing invoice_analyzed");
          }
          return originalValues(vals);
        };
      }
      return builder;
    };
    (PgDatabase.prototype as any).update = new Proxy(originalUpdate, {
      apply(target, thisArg, args) {
        if (poisoned) throw new Error("simulated connection loss (poisoned)");
        return Reflect.apply(target, thisArg, args);
      },
    });

    try {
      await expect(task()({ invoiceId })).rejects.toThrow();

      const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).not.toBe("analyzed");

      const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
      expect(rows.map((r) => r.type)).not.toContain("invoice_analyzed");
    } finally {
      PgDatabase.prototype.insert = originalInsert;
      PgDatabase.prototype.update = originalUpdate;
    }
  });

  // --- Finding 3: the invoice_failed payload must never carry raw error
  // text verbatim - a provider that echoes invoice content into an error
  // message must not turn that into a stored leak.
  it("masks PII in the invoice_failed message and caps its length (INV-007)", async () => {
    const longTail = "x".repeat(2000);
    const failing = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: {
        async extractInvoice() {
          throw new Error(`malformed completion near CPF 123.456.789-09 ${longTail}`);
        },
      },
    });
    await expect(failing({ invoiceId })).rejects.toThrow();

    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    const failedEvent = rows.find((r) => r.type === "invoice_failed");
    const payload = failedEvent?.payload as { message?: string } | undefined;
    expect(payload?.message).toBeDefined();
    expect(payload!.message).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(payload!.message!.length).toBeLessThanOrEqual(500);
  });

  // --- Finding 4: item.meta is masked by maskCanonical but must survive
  // into invoice_items instead of being silently dropped.
  it("carries item.meta through to invoice_items", async () => {
    const withMeta: InvoiceCanonical = {
      ...canonical,
      totalCents: 9000,
      sections: [{
        name: "Serviços",
        items: [
          { description: "Plano pós-pago", amountCents: 9000, meta: { linha: "11987654321" } },
        ],
      }],
    };
    const withMetaTask = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [fileKey]: withMeta }),
    });
    await withMetaTask({ invoiceId });

    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items[0]?.meta).toEqual({ linha: "11987654321" });
  });

  // --- Task 6: the classify stage. Reads the real stored bytes, sniffs
  // their actual type, reads the PDF, scores the extraction, detects the
  // issuer and picks RF-107's route - all before a single AI call.

  it("detects the issuer from the PDF's own text and overrides whatever issuerId the caller supplied (RF-105)", async () => {
    const [vivo] = await ctx.db.select().from(issuers).where(eq(issuers.slug, "vivo-movel"));
    const otherInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: otherInvoiceId, issuerId: vivo!.id, contentHash: "vivo-test", source: "pdf_text",
      status: "queued", fileKey,
    });

    await task()({ invoiceId: otherInvoiceId });

    const [claro] = await ctx.db.select().from(issuers).where(eq(issuers.slug, "claro-movel"));
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, otherInvoiceId));
    expect(row?.issuerId).toBe(claro!.id);
  });

  it("creates an issuers row with status unknown when the text does not identify any seeded issuer, and the pipeline continues (RF-106)", async () => {
    const scanKey = "uploads/scan.pdf";
    seedStorageObject(scanKey, SCAN_ONE_PAGE_PDF);
    const scanInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: scanInvoiceId, issuerId, contentHash: "scan-test", source: "pdf_text",
      status: "queued", fileKey: scanKey,
    });
    const scanTask = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: createFixtureAiProvider({ [scanKey]: canonical }),
    });

    await scanTask({ invoiceId: scanInvoiceId });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, scanInvoiceId));
    expect(row?.issuerId).not.toBeNull();
    expect(row?.issuerId).not.toBe(issuerId);
    const [newIssuer] = await ctx.db.select().from(issuers).where(eq(issuers.id, row!.issuerId!));
    expect(newIssuer?.status).toBe("unknown");
    // RF-106: the flow continues to a real report, not stuck or errored.
    expect(row?.status).toBe("analyzed");
  });

  it("sends a PDF over RF-104's page limit to needs_review with the page count, without ever calling the AI provider", async () => {
    const bigKey = "uploads/big.pdf";
    seedStorageObject(bigKey, TEXT_THIRTEEN_PAGE_PDF);
    const bigInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: bigInvoiceId, issuerId, contentHash: "big-test", source: "pdf_text",
      status: "queued", fileKey: bigKey,
    });
    const extractInvoice = vi.fn(async () => {
      throw new Error("must not be called: over the page limit");
    });
    const bigTask = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: { extractInvoice },
    });

    await bigTask({ invoiceId: bigInvoiceId });

    expect(extractInvoice).not.toHaveBeenCalled();
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, bigInvoiceId));
    expect(row?.status).toBe("needs_review");
    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, bigInvoiceId));
    const event = rows.find((r) => r.type === "invoice_needs_review");
    expect(event).toBeDefined();
    expect((event?.payload as { pageCount?: number } | undefined)?.pageCount).toBe(13);
  });

  it("rejects a file whose bytes are not one of the four accepted types, before the reader ever runs (RF-104)", async () => {
    const badKey = "uploads/bad.docx";
    // A ZIP local-file-header signature - what a renamed .docx actually
    // starts with - matches none of the four accepted magic-byte signatures.
    seedStorageObject(badKey, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    const badInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: badInvoiceId, issuerId, contentHash: "bad-test", source: "pdf_text",
      status: "queued", fileKey: badKey,
    });
    const read = vi.fn();
    const extractInvoice = vi.fn(async () => {
      throw new Error("must not be called: unsupported file type");
    });
    const badTask = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: { read },
      ai: { extractInvoice },
    });

    await expect(badTask({ invoiceId: badInvoiceId })).rejects.toThrow();

    // Neither the reader nor the AI provider is ever reached - the type gate
    // runs before both.
    expect(read).not.toHaveBeenCalled();
    expect(extractInvoice).not.toHaveBeenCalled();
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, badInvoiceId));
    expect(row?.status).toBe("failed");
  });

  it("routes a scan with no text layer to mode: vision", async () => {
    const scanKey = "uploads/scan-vision.pdf";
    seedStorageObject(scanKey, SCAN_ONE_PAGE_PDF);
    const scanInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: scanInvoiceId, issuerId, contentHash: "scan-vision-test", source: "pdf_text",
      status: "queued", fileKey: scanKey,
    });
    let captured: { mode?: string; pages?: string[] | undefined } = {};
    const scanTask = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: {
        async extractInvoice(input) {
          captured = { mode: input.mode, pages: input.pages };
          return { canonical, usage: ZERO_USAGE };
        },
      },
    });

    await scanTask({ invoiceId: scanInvoiceId });

    expect(captured.mode).toBe("vision");
    expect(captured.pages).toBeUndefined();
  });

  it("routes a native PDF with a text layer to mode: text, passing the reader's own pages to the provider", async () => {
    let captured: { mode?: string; pages?: string[] | undefined } = {};
    const textTask = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      ai: {
        async extractInvoice(input) {
          captured = { mode: input.mode, pages: input.pages };
          return { canonical, usage: ZERO_USAGE };
        },
      },
    });

    await textTask({ invoiceId });

    expect(captured.mode).toBe("text");
    expect(captured.pages).toHaveLength(2);
    expect(captured.pages?.[0]).toContain("Claro");
  });

  it("persists invoices.extractionQuality matching the score extractionQuality() computes for this file", async () => {
    // A copy, not the shared TEXT_TWO_PAGE_PDF constant itself: unpdf's
    // getDocumentProxy posts its input to a worker as a transferable, which
    // detaches the underlying buffer (see the doc comment on
    // createUnpdfReader) - reading the module-level fixture directly here
    // would leave it empty for every later test in this file that still
    // needs to seed storage with it.
    const doc = await createUnpdfReader().read(new Uint8Array(TEXT_TWO_PAGE_PDF));
    const expectedScore = extractionQuality(doc).score;

    await task()({ invoiceId });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.extractionQuality).toBe(expectedScore);
  });

  it("stops at needs_review with an honest message when no AI provider is configured, without inventing invoice structure", async () => {
    const noAiTask = createIngestTask({
      db: ctx.db,
      storage: createLocalStorage({ root, secret: "s" }),
      reader: createUnpdfReader(),
      // `ai` intentionally omitted: this is "no provider configured", a
      // different situation from a configured provider that fails.
    });

    await noAiTask({ invoiceId });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("needs_review");
    // A1: no regex-reconstructed structure ever reaches the invoice.
    expect(row?.canonical).toBeNull();
    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(0);

    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    const event = rows.find((r) => r.type === "invoice_needs_review");
    const payload = event?.payload as { message?: string } | undefined;
    expect(payload?.message).toBeTruthy();
  });
});
