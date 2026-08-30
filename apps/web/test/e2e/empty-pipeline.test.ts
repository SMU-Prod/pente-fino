import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "@pentefino/core";
import { createFixtureAiProvider, createInProcessQueue, createLocalStorage } from "@pentefino/adapters";
import { createTestDb, type TestDb } from "@pentefino/db/testing";
import { ensureAnonymousSession, events, invoiceItems, withUser } from "@pentefino/db";
import { createIngestTask } from "@pentefino/jobs";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

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
 *
 * Fix pass 1 reworked the happy-path test to drive the three real route
 * handlers (sign, process, report) with a session cookie carried between
 * them, the same way a browser would, instead of calling the storage
 * adapter / `withUser` / a locally built queue directly. `next/headers` and
 * `../../lib/container.js` are mocked the same way every other route test in
 * this app mocks them (`buildTestContainer`, `createCookieStore`/`jarFor`),
 * so this still exercises the real ingest task and a real database - only
 * the "which container does the route resolve" seam is swapped.
 */
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { POST: signUpload } = await import("../../app/api/uploads/sign/route.js");
const { POST: processInvoice } = await import("../../app/api/invoices/[id]/process/route.js");
const { GET: getReport } = await import("../../app/api/invoices/[id]/report/route.js");

const SECRET = "e2e-route-secret";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../../fixtures/synthetic/claro-movel-2026-07.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

// Stand-in upload bytes ("%PDF"). `createLocalStorage`'s `signUpload()`
// derives the fileKey deterministically from the content hash
// (`uploads/<hash>.<ext>`, see packages/adapters/src/storage/local.ts), so
// the exact key the sign route will mint can be computed ahead of time and
// used to register the AI fixture before any route runs.
const FILE_BYTES = new Uint8Array([37, 80, 68, 70]);
const FILE_HASH = createHash("sha256").update(FILE_BYTES).digest("hex");
const FILE_KEY = `uploads/${FILE_HASH}.pdf`;

// RF-140: anonymous sessions live for 30 days. `invoices.session_id` carries
// a real foreign key to `anonymous_sessions.id`, so the session row must
// exist before `insertInvoice` runs (packages/db's `ensureAnonymousSession`).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-e2e-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-e2e-mail-"));
  vi.mocked(container).mockReturnValue(
    buildTestContainer({ db: ctx.db, storageRoot, mailRoot, fixtures: { [FILE_KEY]: fixture } }),
  );
});

afterEach(async () => {
  await ctx.close();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailRoot, { recursive: true, force: true });
  delete process.env.SESSION_SIGNING_SECRET;
  vi.restoreAllMocks();
});

function useCookies(store: MockCookieStore) {
  vi.mocked(cookies).mockImplementation(async () => jarFor(store) as never);
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("E0 acceptance · a fixture invoice crosses the empty pipeline", () => {
  it("goes from a signed upload to a report with zero findings, through the sign/process/report routes", async () => {
    const store = createCookieStore();
    useCookies(store);

    // 1 · sign — the real route mints the session cookie and the invoice row
    const signResponse = await signUpload(new Request("http://localhost/api/uploads/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentHash: FILE_HASH, mimeType: "application/pdf", sizeBytes: FILE_BYTES.length,
      }),
    }));
    expect(signResponse.status).toBe(200);
    const signed = await signResponse.json();
    expect(signed.fileKey).toBe(FILE_KEY);
    const invoiceId: string = signed.invoiceId;
    // The cookie a real browser would carry into every request that follows.
    expect(store.has("pf_session")).toBe(true);

    // 2 · the bytes land in storage. A client would PUT them straight to the
    // signed URL (R2 in production) - E0 exposes no app route for that step,
    // so there is no route to drive here, only the adapter the signed URL
    // actually points at.
    const { storage } = container();
    await storage.put(signed.fileKey, FILE_BYTES);

    // 3 · process — same session cookie, a second real HTTP-shaped request
    const processResponse = await processInvoice(
      new Request(`http://localhost/api/invoices/${invoiceId}/process`, { method: "POST" }),
      ctxFor(invoiceId),
    );
    expect(processResponse.status).toBe(202);

    // 4 · the report — same cookie again, a third real request. The route's
    // own response body is what gets asserted, not a recomputation of
    // totals from a direct query against the database.
    const reportResponse = await getReport(
      new Request(`http://localhost/api/invoices/${invoiceId}/report`),
      ctxFor(invoiceId),
    );
    expect(reportResponse.status).toBe(200);
    const report = await reportResponse.json();
    expect(report.invoice.status).toBe("analyzed");
    expect(report.invoice.totalCents).toBe(12990);
    expect(report.findings).toEqual([]);
    // The engine has no rules at E0 and must not pretend to judge: the
    // report route's own suspectCents/doubledCents reduction over `findings`
    // (PRD §8.2) comes out to exactly zero, not merely "the list is empty".
    expect(report.totals).toEqual({ suspectCents: 0, doubledCents: 0 });
    // Issuer detection (RF-105/RF-106) is not implemented at E0; the sign
    // route never assigns an issuerId, so the report must say so plainly.
    expect(report.issuer).toBeNull();

    // 5 · item rows are inspected, not merely counted: description,
    // normalised description, amount, section and line number for each of
    // the fixture's three lines survive the trip through mask → persist.
    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    const byLine = [...items].sort((a, b) => a.lineNo - b.lineNo);
    expect(byLine).toHaveLength(3);
    expect(byLine[0]).toMatchObject({
      lineNo: 0,
      section: "Serviços",
      description: "Plano pós-pago 20GB",
      normalizedDesc: "PLANO POS PAGO 20GB",
      amountCents: 9990,
    });
    expect(byLine[1]).toMatchObject({
      lineNo: 1,
      section: "Serviços",
      description: "Aplicativos Digitais - Revista X",
      normalizedDesc: "APLICATIVOS DIGITAIS REVISTA X",
      amountCents: 1500,
    });
    expect(byLine[2]).toMatchObject({
      lineNo: 2,
      section: "Serviços",
      // The digit run is masked; the "CPF" label itself is not PII on its
      // own and survives untouched (RF-109 / packages/core/src/invoice/mask.ts).
      description: "Titular CPF [CPF]",
      normalizedDesc: "TITULAR CPF CPF",
      amountCents: 1500,
    });

    // 6 · no PII survived (INV-007), proven end to end: neither in the
    // canonical the report route itself returns...
    expect(JSON.stringify(report.invoice.canonical)).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    // ...nor in any of the item rows derived from that same canonical.
    expect(JSON.stringify(items)).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);

    // 7 · the event trail exists, correlated by invoiceId (A3): every event
    // this path produces now carries the column `events.invoiceId` exists
    // for, so a real consumer - a metric, the adaptive engine, an audit -
    // can read exactly this invoice's trail even from a session that holds
    // more than one. Only the three events' relative order is asserted, not
    // an exact array over `occurredAt` across three separate statements,
    // which can tie on fast hardware.
    const trail = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    const uploaded = trail.find((e) => e.type === "invoice_uploaded");
    const extracted = trail.find((e) => e.type === "invoice_extracted");
    const analyzed = trail.find((e) => e.type === "invoice_analyzed");
    expect(uploaded).toBeDefined();
    expect(extracted).toBeDefined();
    expect(analyzed).toBeDefined();
    expect(uploaded!.occurredAt.getTime()).toBeLessThanOrEqual(extracted!.occurredAt.getTime());
    expect(extracted!.occurredAt.getTime()).toBeLessThanOrEqual(analyzed!.occurredAt.getTime());
  });

  it("re-processing the same invoice through the queue changes nothing (A4)", async () => {
    const sessionId = newId("ses");
    await ensureAnonymousSession(sessionId, new Date(Date.now() + SESSION_TTL_MS), ctx.db);
    const scoped = withUser({ sessionId }, ctx.db);

    const storage = createLocalStorage({ root: storageRoot, secret: "s" });
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

    // This proves the queue's own idempotency-key dedup short-circuits a
    // second enqueue with the same key before the handler runs again - it
    // says nothing about the ingest task's own guard, which the next test
    // exercises directly (finding 2: this assertion alone would not go red
    // if that guard were deleted, because the queue never gets that far).
    expect(second.deduplicated).toBe(true);

    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(3);

    const aiCallRows = await ctx.db.query.aiCalls.findMany();
    expect(aiCallRows).toHaveLength(1);

    const trail = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    expect(trail.filter((e) => e.type === "invoice_extracted")).toHaveLength(1);
    expect(trail.filter((e) => e.type === "invoice_analyzed")).toHaveLength(1);
  });

  // --- Finding 2: the test above only proves the in-process queue's
  // idempotency-key map stops a second `enqueue()` before the handler ever
  // runs again - it would still pass even if `apps/jobs/src/tasks/ingest.ts`
  // deleted its own `status === "analyzed"` guard, because the queue never
  // lets the call through a second time regardless of what the handler does.
  // This test invokes the ingest task function directly, twice, with no
  // queue between the two calls, so the guard inside the task itself is the
  // only thing that can make the second call a no-op.

  it("running the ingest task directly, twice, with no queue in between, has no second effect (A4)", async () => {
    const sessionId = newId("ses");
    await ensureAnonymousSession(sessionId, new Date(Date.now() + SESSION_TTL_MS), ctx.db);
    const scoped = withUser({ sessionId }, ctx.db);

    const storage = createLocalStorage({ root: storageRoot, secret: "s" });
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

    await ingest({ invoiceId });
    await ingest({ invoiceId }); // the task function itself, called twice - no queue involved at all

    const items = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    expect(items).toHaveLength(3);

    const aiCallRows = await ctx.db.query.aiCalls.findMany();
    expect(aiCallRows).toHaveLength(1);

    const trail = await ctx.db.select().from(events).where(eq(events.invoiceId, invoiceId));
    expect(trail.filter((e) => e.type === "invoice_extracted")).toHaveLength(1);
    expect(trail.filter((e) => e.type === "invoice_analyzed")).toHaveLength(1);
  });
});
