import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@pentefino/core";
import { createFixtureAiProvider, createInProcessQueue, createLocalStorage } from "@pentefino/adapters";
import { createTestDb, type TestDb } from "@pentefino/db/testing";
import { ensureAnonymousSession, events, invoiceItems, invoices, issuers, withUser } from "@pentefino/db";
import { createIngestTask } from "@pentefino/jobs";

/**
 * Task 15 — the E0 acceptance criterion (§18): a fixture invoice crosses the
 * whole path (sign → upload → own → queue → ingest → report) against a real
 * (PGlite) database, with no network and no external account.
 *
 * `fixtures/synthetic/claro-movel-2026-07.json` is hand-written for this
 * test, not a golden-set sample - its own `_note` field says so. It exists to
 * prove the pipeline moves an invoice end to end and masks what it must,
 * not that extraction is accurate against a real layout (that is what the
 * still-empty `fixtures/golden/` is for, per its README).
 */
const fixture = JSON.parse(
  readFileSync(new URL("../../../../fixtures/synthetic/claro-movel-2026-07.json", import.meta.url), "utf8"),
);

// Stand-in upload bytes ("%PDF"). What matters here is that signUpload() and
// put() are both given this content's *real* size and SHA-256 hash: the
// local storage adapter's put() binds to whatever signUpload() was called
// with and rejects a body that doesn't match (Task 8) - that is the adapter
// working correctly, not something for this test to route around.
const FILE_BYTES = new Uint8Array([37, 80, 68, 70]);
const FILE_HASH = createHash("sha256").update(FILE_BYTES).digest("hex");

// RF-140: anonymous sessions live for 30 days. `invoices.session_id` carries
// a real foreign key to `anonymous_sessions.id`, so the session row must
// exist before `insertInvoice` runs (packages/db's `ensureAnonymousSession`).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let ctx: TestDb;
let root: string;

beforeEach(async () => {
  ctx = await createTestDb();
  root = mkdtempSync(join(tmpdir(), "pf-e2e-"));
});
afterEach(async () => {
  await ctx.close();
  rmSync(root, { recursive: true, force: true });
});

describe("E0 acceptance · a fixture invoice crosses the empty pipeline", () => {
  it("goes from signed upload to analyzed with zero findings", async () => {
    const sessionId = newId("ses");
    await ensureAnonymousSession(sessionId, new Date(Date.now() + SESSION_TTL_MS), ctx.db);
    const scoped = withUser({ sessionId }, ctx.db);

    await ctx.db.insert(issuers).values({
      id: newId("iss"), slug: "claro-movel", category: "telecom", displayName: "Claro Móvel",
    });

    // 1 · sign the upload
    const storage = createLocalStorage({ root, secret: "s" });
    const signed = await storage.signUpload({
      contentHash: FILE_HASH, mimeType: "application/pdf", sizeBytes: FILE_BYTES.length,
    });
    expect(storage.verify(signed.uploadUrl).valid).toBe(true);

    // 2 · the file lands in storage
    await storage.put(signed.fileKey, FILE_BYTES);
    expect(await storage.get(signed.fileKey)).not.toBeNull();

    // 3 · the invoice row exists, owned by the anonymous session
    const invoiceId = await scoped.insertInvoice({
      contentHash: FILE_HASH, source: "pdf_text", fileKey: signed.fileKey,
    });
    await scoped.recordEvent("invoice_uploaded", { source: "application/pdf" });

    // 4 · process
    const queue = createInProcessQueue({
      ingest: createIngestTask({
        db: ctx.db,
        storage,
        ai: createFixtureAiProvider({ [signed.fileKey]: fixture }),
      }),
    });
    await queue.enqueue("ingest", { invoiceId }, { idempotencyKey: `ingest:${invoiceId}` });

    // 5 · the report
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("analyzed");
    expect(row?.totalCents).toBe(12990);

    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(3);

    const findings = await scoped.findingsForInvoice(invoiceId);
    expect(findings).toEqual([]);

    // The engine has no rules at E0 and must not pretend to judge: the same
    // reduction the report route (PRD §8.2) runs over `findings` comes out
    // to exactly zero, not merely "the list is empty".
    const suspectCents = findings.reduce((acc, f) => acc + f.amountCents, 0);
    const doubledCents = findings.reduce((acc, f) => acc + (f.doubledCents ?? 0), 0);
    expect(suspectCents).toBe(0);
    expect(doubledCents).toBe(0);

    // 6 · no PII survived (INV-007), proven end to end rather than in
    // isolation: neither in the canonical the ingest task persisted...
    expect(JSON.stringify(row?.canonical)).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    // ...nor in any of the item rows derived from that same canonical.
    expect(JSON.stringify(items)).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);

    // 7 · the event trail exists, in order (A3). Read through the same
    // ownership-scoped door metrics/auditing would use (`scoped.events()`,
    // INV-008) rather than by `events.invoiceId` directly: `invoice_uploaded`
    // is recorded by the upload-sign step (see apps/web's
    // /api/uploads/sign route) before an invoice row - and so an invoiceId -
    // even exists, so it only ever carries `sessionId`. `invoice_extracted`
    // and `invoice_analyzed`, recorded by the ingest task, carry both. All
    // three carry `sessionId`, which is what actually threads them together.
    const trail = await scoped.events(); // desc(occurredAt)
    expect(trail.map((e) => e.type).reverse()).toEqual([
      "invoice_uploaded", "invoice_extracted", "invoice_analyzed",
    ]);
  });

  it("re-processing the same invoice changes nothing (A4)", async () => {
    const sessionId = newId("ses");
    await ensureAnonymousSession(sessionId, new Date(Date.now() + SESSION_TTL_MS), ctx.db);
    const scoped = withUser({ sessionId }, ctx.db);
    await ctx.db.insert(issuers).values({
      id: newId("iss"), slug: "claro-movel", category: "telecom", displayName: "Claro Móvel",
    });

    const storage = createLocalStorage({ root, secret: "s" });
    const signed = await storage.signUpload({
      contentHash: FILE_HASH, mimeType: "application/pdf", sizeBytes: FILE_BYTES.length,
    });
    await storage.put(signed.fileKey, FILE_BYTES);
    const invoiceId = await scoped.insertInvoice({
      contentHash: FILE_HASH, source: "pdf_text", fileKey: signed.fileKey,
    });
    const ingest = createIngestTask({
      db: ctx.db, storage, ai: createFixtureAiProvider({ [signed.fileKey]: fixture }),
    });
    const queue = createInProcessQueue({ ingest });

    await queue.enqueue("ingest", { invoiceId }, { idempotencyKey: `ingest:${invoiceId}` });
    const second = await queue.enqueue("ingest", { invoiceId }, { idempotencyKey: `ingest:${invoiceId}` });

    expect(second.deduplicated).toBe(true);

    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(3);

    // No duplicate items is not enough on its own - the queue's idempotency
    // key must stop the handler from running a second time at all, not just
    // happen to converge on the same rows. Confirmed directly: one ai_calls
    // row, and each pipeline event recorded exactly once.
    const aiCallRows = await ctx.db.query.aiCalls.findMany();
    expect(aiCallRows).toHaveLength(1);

    const trail = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    expect(trail.filter((e) => e.type === "invoice_extracted")).toHaveLength(1);
    expect(trail.filter((e) => e.type === "invoice_analyzed")).toHaveLength(1);
  });
});
