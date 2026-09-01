import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { newId, type InvoiceCanonical } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, invoices, issuers } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { POST } = await import("../../app/api/invoices/[id]/process/route.js");
const { ingestIdempotencyKey } = await import("../../lib/ingest-key.js");

/** A promise plus its resolve/reject, for controlling exactly when the AI call settles (Task 1). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Task 1 (E3): the route no longer awaits ingestion, so a test can no longer
 * assume the pipeline has finished just because `POST` resolved. This joins
 * the same run through the queue's own idempotency contract - the identical
 * public `enqueue()` call the route itself made, with the same key - rather
 * than a `setTimeout` guess or a test-only escape hatch: it resolves once
 * the background run actually settles, whether that is already true
 * (`completed`) or still running (`inFlight`), exactly as
 * packages/adapters/src/queue/in-process.ts already guarantees for any two
 * calls sharing a key.
 */
async function drainIngest(invoiceId: string) {
  const { queue } = container();
  await queue.enqueue("ingest", { invoiceId }, { idempotencyKey: ingestIdempotencyKey(invoiceId) }).catch(() => {});
}

const SECRET = "route-test-secret";

const canonical = {
  issuer: { name: "Claro Móvel", cnpj: "40432544000147", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 9000,
  sections: [{ name: "Serviços", items: [{ description: "Plano pós-pago", amountCents: 9000 }] }],
  extraction: { confidence: 0.95, warnings: [] },
} as InvoiceCanonical;

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
const fileKey = "uploads/proc.pdf";
const sessionA = "ses_owner00000000000000";
const sessionB = "ses_other00000000000000";
let invoiceId: string;

// A real, parseable PDF, not placeholder bytes: the ingest task's classify
// stage (Task 6) now actually sniffs and reads what is in storage. This
// route's own tests care about the HTTP/ownership mechanics, not extraction
// content, so a textless scan (no issuer identity implied) is the neutral
// choice - reused from the same committed fixtures the unpdf reader's own
// tests use (packages/adapters/src/reader/unpdf.test.ts).
const SCAN_PDF = new Uint8Array(readFileSync(
  fileURLToPath(new URL("../../../../fixtures/synthetic/pdfs/scan-1page.pdf", import.meta.url)),
));

function seedStorageObject(key: string) {
  const target = join(storageRoot, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, SCAN_PDF);
}

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(
    buildTestContainer({ db: ctx.db, storageRoot, mailRoot, fixtures: { [fileKey]: canonical } }),
  );

  seedStorageObject(fileKey);
  await ctx.db.insert(anonymousSessions).values([
    { id: sessionA, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionB, expiresAt: new Date(Date.now() + 60_000) },
  ]);
  const issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, issuerId, sessionId: sessionA, contentHash: "proc-hash", source: "pdf_text",
    status: "queued", fileKey,
  });
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

function request(): Request {
  return new Request(`http://localhost/api/invoices/${invoiceId}/process`, { method: "POST" });
}

describe("POST /api/invoices/[id]/process", () => {
  it("returns forbidden with no session cookie at all", async () => {
    useCookies(createCookieStore());
    const response = await POST(request(), ctxFor(invoiceId));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
  });

  // --- INV-008: this route touches user data (it runs the ingestion
  // pipeline for the invoice's owner) and must gate on ownership the same
  // way the report route does, even though the brief's own version of this
  // route never checked it.

  it("returns not_found, not the other session's invoice, when a different session's cookie is presented (INV-008)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const response = await POST(request(), ctxFor(invoiceId));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");

    // And no side effect: the invoice must not have been processed for B.
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("queued");
  });

  it("returns not_found for an invoice id that does not exist at all, indistinguishably from one owned by someone else", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const missingId = newId("inv");
    const response = await POST(new Request(`http://localhost/api/invoices/${missingId}/process`, { method: "POST" }), ctxFor(missingId));
    expect(response.status).toBe(404);
  });

  it("enqueues and actually runs the ingest pipeline for the owning session, reaching analyzed (202)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await POST(request(), ctxFor(invoiceId));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ invoiceId, status: "queued" });

    // Task 1 (E3): the route no longer awaits the queue, so the response
    // above tells us nothing about whether ingestion has finished - only
    // that it was accepted. `drainIngest` joins the same run through the
    // queue's own idempotency contract before this assertion is meaningful.
    await drainIngest(invoiceId);
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("analyzed");
  });

  // --- Task 1 (E3): the queue stops blocking the response. `POST /process`
  // used to `await queue.enqueue(...)`, so classify/extract/validate/persist
  // all ran inside the request - the exact thing that made RF-141's progress
  // stream impossible (nothing happens between "queued" and "done" from the
  // client's point of view) and RNF-01's "time to report" indistinguishable
  // from the request's own duration. This proves the decoupling directly: the
  // response comes back while a gated AI call is still pending, not after.

  it("returns 202 before ingestion finishes, running it after the response instead of inside it (Task 1)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const gate = deferred<void>();
    vi.mocked(container).mockReturnValue(
      buildTestContainer({
        db: ctx.db, storageRoot, mailRoot,
        ai: {
          async extractInvoice() {
            await gate.promise;
            return {
              canonical,
              usage: { provider: "fixture", model: "fixture", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
            };
          },
        },
      }),
    );

    const response = await POST(request(), ctxFor(invoiceId));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ invoiceId, status: "queued" });

    // The AI call is still gated shut at this point - if the route were
    // still awaiting ingestion, reaching here would be impossible.
    const [midFlight] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(midFlight?.status).not.toBe("analyzed");

    gate.resolve();
    await drainIngest(invoiceId);
    const [settled] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(settled?.status).toBe("analyzed");
  });

  it("does not re-run extraction when the same owner calls process twice for the same invoice (idempotency, A4)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await POST(request(), ctxFor(invoiceId));
    await POST(request(), ctxFor(invoiceId));
    await drainIngest(invoiceId);

    const rows = await ctx.db.query.aiCalls.findMany();
    expect(rows).toHaveLength(1);
  });

  // --- Task 1 (E3): `extraction_failed` (422) was this route's HTTP
  // translation of a failure raised *inside* the `await queue.enqueue(...)`
  // call it used to make. Now that ingestion runs after the response has
  // already gone out, a failure there can no longer become this route's
  // status code - by the time it happens there is no response left to
  // shape. Nothing about visibility regresses: the ingest task's own
  // try/catch (apps/jobs/src/tasks/ingest.ts) already flips the invoice to
  // `status: "failed"` and writes an `invoice_failed` event before this
  // route ever ran; the 422 was only ever a same-request echo of that
  // durable record, never the record itself. These two tests - previously
  // "returns extraction_failed (422)..." - now pin the new contract: 202
  // immediately, `failed` once the caller observes the same run settle.
  // `not_found` is unaffected and untested here again: ownership is still
  // checked synchronously, before anything is enqueued (see the tests above).

  it("still returns 202 when ingest will genuinely fail with a message that contains the words \"not found\", and the invoice ends up failed, not a false not_found (Task 1)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    vi.mocked(container).mockReturnValue(
      buildTestContainer({
        db: ctx.db, storageRoot, mailRoot,
        ai: { async extractInvoice() { throw new Error("model gpt-9-mini not found"); } },
      }),
    );

    const response = await POST(request(), ctxFor(invoiceId));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ invoiceId, status: "queued" });

    // The invoice genuinely exists and failed - not the same thing as
    // "not found" - so it must be left in the real failed state, not queued
    // or silently reset. Only visible now by reading it back after the
    // background run has actually settled.
    await drainIngest(invoiceId);
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("failed");
  });

  it("still returns 202 for a genuine extraction failure with an unrelated message, and the invoice ends up failed (Task 1)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    vi.mocked(container).mockReturnValue(
      buildTestContainer({
        db: ctx.db, storageRoot, mailRoot,
        ai: { async extractInvoice() { throw new Error("malformed completion from provider"); } },
      }),
    );

    const response = await POST(request(), ctxFor(invoiceId));
    expect(response.status).toBe(202);

    await drainIngest(invoiceId);
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("failed");
  });
});
