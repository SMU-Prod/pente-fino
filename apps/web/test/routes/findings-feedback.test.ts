import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
const { POST } = await import("../../app/api/findings/[id]/feedback/route.js");

const SECRET = "findings-feedback-test-secret";

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
const sessionA = "ses_owner00000000000000";
const sessionB = "ses_other00000000000000";
let invoiceId: string;
let findingId: string;

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
  const issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, issuerId, sessionId: sessionA, contentHash: "feedback-hash", source: "pdf_text",
    status: "analyzed",
  });
  const ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "x" }, confidenceBase: 0.5, author: "system", reason: "fixture",
  });
  findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1500,
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

function request(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/findings/${id}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/findings/[id]/feedback", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await POST(request(findingId, { action: "dismiss" }), ctxFor(findingId));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Você não tem acesso a esse item." },
    });
  });

  it("dismisses a finding the caller owns, returns { ok: true }, and records finding_dismissed", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await POST(request(findingId, { action: "dismiss" }), ctxFor(findingId));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [row] = await ctx.db.select().from(findings).where(eq(findings.id, findingId));
    expect(row?.status).toBe("dismissed_by_user");

    const events = await withUser({ sessionId: sessionA }, ctx.db).events();
    const dismissed = events.find((e) => e.type === "finding_dismissed");
    expect(dismissed).toBeTruthy();
    expect(dismissed?.invoiceId).toBe(invoiceId);
  });

  it("confirms a finding and records the optional answer on the event payload", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await POST(request(findingId, { action: "confirm", answer: "Sim" }), ctxFor(findingId));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [row] = await ctx.db.select().from(findings).where(eq(findings.id, findingId));
    expect(row?.status).toBe("confirmed_by_user");

    const events = await withUser({ sessionId: sessionA }, ctx.db).events();
    const confirmed = events.find((e) => e.type === "finding_confirmed");
    expect(confirmed?.payload).toEqual({ answer: "Sim" });
  });

  it("confirms a finding with no answer, leaving the event payload empty", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await POST(request(findingId, { action: "confirm" }), ctxFor(findingId));

    const events = await withUser({ sessionId: sessionA }, ctx.db).events();
    const confirmed = events.find((e) => e.type === "finding_confirmed");
    expect(confirmed?.payload).toEqual({});
  });

  // --- INV-008, the property this task's brief specifically calls out:
  // a session must not be able to dismiss or confirm another session's
  // finding, and must not learn whether a finding id exists at all.

  it("does not let a different session dismiss another session's finding (INV-008)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const response = await POST(request(findingId, { action: "dismiss" }), ctxFor(findingId));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Não encontramos esse item." },
    });

    const [row] = await ctx.db.select().from(findings).where(eq(findings.id, findingId));
    expect(row?.status).toBe("open"); // untouched by the rejected attempt

    const events = await withUser({ sessionId: sessionA }, ctx.db).events();
    expect(events.map((e) => e.type)).not.toContain("finding_dismissed");
  });

  it("returns the same not_found for someone else's finding as for one that does not exist, so existence is never leaked", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const otherResponse = await POST(request(findingId, { action: "dismiss" }), ctxFor(findingId));
    const missingId = newId("fnd");
    const missingResponse = await POST(request(missingId, { action: "dismiss" }), ctxFor(missingId));

    expect(otherResponse.status).toBe(missingResponse.status);
    expect(await otherResponse.json()).toEqual(await missingResponse.json());
  });

  it("rejects an unknown action the same way as an unknown finding, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await POST(request(findingId, { action: "yolo" }), ctxFor(findingId));
    expect(response.status).toBe(404);

    const [row] = await ctx.db.select().from(findings).where(eq(findings.id, findingId));
    expect(row?.status).toBe("open");
  });

  it("rejects malformed JSON the same way, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const malformed = new Request(`http://localhost/api/findings/${findingId}/feedback`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    const response = await POST(malformed, ctxFor(findingId));
    expect(response.status).toBe(404);
  });
});
