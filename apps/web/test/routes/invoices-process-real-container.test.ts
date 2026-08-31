import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type InvoiceCanonical } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";

const { anonymousSessions, invoices, issuers } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

// Deliberately NOT mocking ../../lib/container.js (Task 14, finding 1). Every
// other route test in this app replaces the whole module with `vi.mock` and
// hands back one object both of a route's `container()` calls share - which
// is exactly what let the idempotency bug hide: a `vi.fn()` stub returning a
// cached object has the memoized shape production needs, but production's
// real `container()` did not have it. This file goes through the real
// `container()` instead, priming its singleton once with the test database
// and a fixture AI provider before the route ever calls it, then proving two
// separate calls into the route - the shape two separate HTTP requests would
// take - still share the one queue that call built.

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
let dataRoot: string;
const fileKey = "uploads/real-container.pdf";
const sessionA = "ses_owner00000000000000";
let invoiceId: string;

// A real, parseable PDF, not placeholder bytes: the ingest task's classify
// stage (Task 6) now actually sniffs and reads what is in storage. This
// file's own test cares about queue/container mechanics, not extraction
// content, so a textless scan (no issuer identity implied) is the neutral
// choice - reused from the same committed fixtures the unpdf reader's own
// tests use (packages/adapters/src/reader/unpdf.test.ts).
const SCAN_PDF = new Uint8Array(readFileSync(
  fileURLToPath(new URL("../../../../fixtures/synthetic/pdfs/scan-1page.pdf", import.meta.url)),
));

function seedStorageObject(key: string) {
  // The real container builds its storage adapter from LOCAL_DATA_ROOT
  // (packages/adapters/src/index.ts's buildAdapters), rooted at
  // `<LOCAL_DATA_ROOT>/blobs` - unlike the mocked-container tests, which
  // point a test-only storage root directly at buildTestContainer.
  const target = join(dataRoot, "blobs", key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, SCAN_PDF);
}

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  dataRoot = mkdtempSync(join(tmpdir(), "pf-web-real-container-"));
  process.env.LOCAL_DATA_ROOT = dataRoot;
  ctx = await createTestDb();

  // Primes the memoized singleton (lib/container.ts) with the test database
  // and this invoice's extraction fixture, via the same `db`/`fixtures`
  // overrides `ContainerOverrides` exists to support. Every later no-args
  // `container()` call in this process - including the two the route below
  // makes, one per POST - must return this exact instance.
  container({ db: ctx.db, fixtures: { [fileKey]: canonical } });

  seedStorageObject(fileKey);
  await ctx.db.insert(anonymousSessions).values([
    { id: sessionA, expiresAt: new Date(Date.now() + 60_000) },
  ]);
  const issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, issuerId, sessionId: sessionA, contentHash: "real-container-hash", source: "pdf_text",
    status: "queued", fileKey,
  });
});

afterEach(async () => {
  await ctx.close();
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.SESSION_SIGNING_SECRET;
  delete process.env.LOCAL_DATA_ROOT;
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

describe("POST /api/invoices/[id]/process, through the real container (Task 14, finding 1)", () => {
  it("shares one queue across two separate requests, so the ingest handler runs only once", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    await POST(request(), ctxFor(invoiceId));
    await POST(request(), ctxFor(invoiceId));

    const rows = await ctx.db.query.aiCalls.findMany();
    expect(rows).toHaveLength(1);
  });
});
