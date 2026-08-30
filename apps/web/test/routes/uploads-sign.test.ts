import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, events, invoices } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { POST } = await import("../../app/api/uploads/sign/route.js");

const SECRET = "route-test-secret";

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));
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

function request(body: unknown): Request {
  return new Request("http://localhost/api/uploads/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = { contentHash: "a".repeat(32), mimeType: "application/pdf", sizeBytes: 1000 };

describe("POST /api/uploads/sign", () => {
  it("creates the anonymous_sessions row for a brand-new visitor before inserting the invoice", async () => {
    const store = createCookieStore();
    useCookies(store);

    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoiceId).toMatch(/^inv_/);

    const [invoiceRow] = await ctx.db.select().from(invoices).where(eq(invoices.id, body.invoiceId));
    expect(invoiceRow?.sessionId).toBeTruthy();
    const [sessionRow] = await ctx.db.select().from(anonymousSessions)
      .where(eq(anonymousSessions.id, invoiceRow!.sessionId!));
    expect(sessionRow?.id).toBe(invoiceRow!.sessionId);
  });

  it("sets a signed, httpOnly, non-production-insecure session cookie for a new visitor", async () => {
    const store = createCookieStore();
    useCookies(store);

    await POST(request(validBody));

    expect(store.has("pf_session")).toBe(true);
    // The cookie must actually verify against the secret the route used -
    // proof it is the real signed value, not a raw session id.
    const { readSession } = await import("../../lib/session.js");
    expect(readSession(store.get("pf_session")!, SECRET)).toMatch(/^ses_/);
  });

  it("does not re-mint or re-set the cookie for a visitor with an existing valid session", async () => {
    const sessionId = "ses_existing0000000000";
    const store = createCookieStore({ pf_session: signSession(sessionId, SECRET) });
    useCookies(store);
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });

    const before = store.get("pf_session");
    await POST(request(validBody));
    expect(store.get("pf_session")).toBe(before); // unchanged - route must not call jar.set() again

    const [invoiceRow] = await ctx.db.select().from(invoices).where(eq(invoices.sessionId, sessionId));
    expect(invoiceRow?.id).toBeDefined();
  });

  it("treats a tampered cookie as no session at all, minting a fresh one instead of trusting it", async () => {
    const store = createCookieStore({ pf_session: "ses_forged.not-a-real-signature" });
    useCookies(store);

    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    const { readSession } = await import("../../lib/session.js");
    const newSessionId = readSession(store.get("pf_session")!, SECRET);
    expect(newSessionId).not.toBe("ses_forged");
  });

  // --- RF-102: signing the same content hash twice for the same owner
  // returns the existing invoice, and never records a second upload event
  // (recordEvent is the only side effect that would announce a fresh
  // upload / trigger downstream extraction bookkeeping).

  it("returns the existing invoice, not a new one, when the same owner signs the same content hash twice (RF-102)", async () => {
    const store = createCookieStore();
    useCookies(store);

    const first = await POST(request(validBody));
    const firstBody = await first.json();

    const second = await POST(request(validBody));
    const secondBody = await second.json();

    expect(secondBody.invoiceId).toBe(firstBody.invoiceId);

    const rows = await ctx.db.select().from(invoices).where(eq(invoices.contentHash, validBody.contentHash));
    expect(rows).toHaveLength(1);
  });

  it("does not record a second invoice_uploaded event on a repeat sign, and never touches the queue (no second extraction)", async () => {
    const store = createCookieStore();
    useCookies(store);

    await POST(request(validBody));
    await POST(request(validBody));

    const invoiceRows = await ctx.db.select().from(invoices).where(eq(invoices.contentHash, validBody.contentHash));
    const allEvents = await ctx.db.select().from(events);
    const uploadedEvents = allEvents.filter(
      (r) => r.type === "invoice_uploaded" && r.sessionId === invoiceRows[0]?.sessionId,
    );
    expect(uploadedEvents).toHaveLength(1);
  });

  it("lets a different session sign the same content hash as its own separate invoice", async () => {
    const storeA = createCookieStore();
    useCookies(storeA);
    const first = await POST(request(validBody));
    const firstBody = await first.json();

    const storeB = createCookieStore();
    useCookies(storeB);
    const second = await POST(request(validBody));
    const secondBody = await second.json();

    expect(secondBody.invoiceId).not.toBe(firstBody.invoiceId);
    const rows = await ctx.db.select().from(invoices).where(eq(invoices.contentHash, validBody.contentHash));
    expect(rows).toHaveLength(2);
  });

  // --- RF-104: size and (declared) type limits

  it("rejects a file over 15 MB with file_too_large (RF-104)", async () => {
    useCookies(createCookieStore());
    const response = await POST(request({ ...validBody, sizeBytes: 15 * 1024 * 1024 + 1 }));
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "file_too_large", message: expect.stringContaining("15 MB") } });
  });

  it("rejects a declared MIME type outside the accepted list with unsupported_type (RF-104)", async () => {
    useCookies(createCookieStore());
    const response = await POST(request({ ...validBody, mimeType: "application/zip" }));
    expect(response.status).toBe(415);
    const body = await response.json();
    expect(body.error.code).toBe("unsupported_type");
  });

  it("shapes every rejection as { error: { code, message } } (PRD §8.1)", async () => {
    useCookies(createCookieStore());
    const response = await POST(request({ ...validBody, sizeBytes: -1 }));
    const body = await response.json();
    expect(body).toHaveProperty("error.code");
    expect(body).toHaveProperty("error.message");
  });

  it("rejects a malformed JSON body with a catalogue-shaped error instead of an unhandled exception", async () => {
    useCookies(createCookieStore());
    const malformed = new Request("http://localhost/api/uploads/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await POST(malformed);
    expect(response.status).toBe(415);
    const body = await response.json();
    expect(body.error.code).toBe("unsupported_type");
  });
});
