import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function seedStorageObject(key: string) {
  const target = join(storageRoot, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "fake pdf bytes");
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

    // The in-process queue (Task 11) runs the handler inline, so by the time
    // the response resolves the real ingest task (Task 13) has already run
    // against the real (PGlite) database - this is a full, real, end-to-end
    // path through the route, not a mocked pipeline.
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("analyzed");
  });

  it("does not re-run extraction when the same owner calls process twice for the same invoice (idempotency, A4)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await POST(request(), ctxFor(invoiceId));
    await POST(request(), ctxFor(invoiceId));

    const rows = await ctx.db.query.aiCalls.findMany();
    expect(rows).toHaveLength(1);
  });
});
