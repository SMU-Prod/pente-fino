import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, findings, invoices, issuers, rules } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { GET } = await import("../../app/api/invoices/[id]/report/route.js");

const SECRET = "route-test-secret";

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
const sessionA = "ses_owner00000000000000";
const sessionB = "ses_other00000000000000";
let invoiceId: string;
let findingId: string;
let issuerId: string;

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));

  await ctx.db.insert(anonymousSessions).values([
    { id: sessionA, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionB, expiresAt: new Date(Date.now() + 60_000) },
  ]);
  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, issuerId, sessionId: sessionA, contentHash: "report-hash", source: "pdf_text", status: "analyzed",
  });

  const ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "x" }, confidenceBase: 0.5, author: "system", reason: "fixture",
  });
  findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1500, doubledCents: 700,
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
  return new Request(`http://localhost/api/invoices/${invoiceId}/report`);
}

describe("GET /api/invoices/[id]/report", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await GET(request(), ctxFor(invoiceId));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "forbidden", message: "Você não tem acesso a esse item." } });
  });

  it("returns forbidden for a tampered cookie, never falling back to trusting the raw value", async () => {
    useCookies(createCookieStore({ pf_session: `${sessionA}.not-a-real-signature` }));
    const response = await GET(request(), ctxFor(invoiceId));
    expect(response.status).toBe(403);
  });

  // --- INV-008, the property this task's brief specifically calls out:
  // prove a session cannot read an invoice belonging to a different session.

  it("does not let a different session read the invoice or its findings (INV-008)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "not_found", message: "Não encontramos esse item." } });
  });

  it("returns the same not_found for someone else's invoice as for one that does not exist, so existence is never leaked", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const otherResponse = await GET(request(), ctxFor(invoiceId));
    const missingId = newId("inv");
    const missingResponse = await GET(
      new Request(`http://localhost/api/invoices/${missingId}/report`), ctxFor(missingId),
    );
    expect(await otherResponse.json()).toEqual(await missingResponse.json());
  });

  it("returns the invoice, findings and totals for the owning session", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice.id).toBe(invoiceId);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].id).toBe(findingId);
    expect(body.totals).toEqual({ suspectCents: 1500, doubledCents: 700 });
  });

  // --- PRD §8.2 declares `issuer` in this endpoint's response shape; it was
  // missing entirely (Task 14, finding 2).

  it("includes the issuer, loaded through the same ownership-scoped path as findings (PRD §8.2)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    const body = await response.json();
    expect(body.issuer).toMatchObject({ id: issuerId, displayName: "Claro" });
  });

  it("returns issuer: null when the invoice has no issuer assigned yet", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const noIssuerId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: noIssuerId, sessionId: sessionA, contentHash: "no-issuer-hash", source: "pdf_text", status: "analyzed",
    });

    const response = await GET(
      new Request(`http://localhost/api/invoices/${noIssuerId}/report`), ctxFor(noIssuerId),
    );
    const body = await response.json();
    expect(body.issuer).toBeNull();
  });

  it("records a report_viewed event for the owning session", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await GET(request(), ctxFor(invoiceId));

    const events = await withUser({ sessionId: sessionA }, ctx.db).events();
    expect(events.map((e) => e.type)).toContain("report_viewed");
  });
});
