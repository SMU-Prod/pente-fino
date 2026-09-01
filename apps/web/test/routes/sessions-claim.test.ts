import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, findings, invoiceItems, invoices, issuers, rules, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { POST: claim } = await import("../../app/api/sessions/claim/route.js");
const { POST: confirm } = await import("../../app/api/sessions/claim/confirm/route.js");

const SECRET = "sessions-claim-test-secret";

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
const sessionA = "ses_owner00000000000000";
const sessionB = "ses_other00000000000000";

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  process.env.CLAIM_CODE_SECRET = SECRET;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));

  await ctx.db.insert(anonymousSessions).values([
    { id: sessionA, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionB, expiresAt: new Date(Date.now() + 60_000) },
  ]);
});

afterEach(async () => {
  await ctx.close();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailRoot, { recursive: true, force: true });
  delete process.env.SESSION_SIGNING_SECRET;
  delete process.env.CLAIM_CODE_SECRET;
  vi.restoreAllMocks();
});

function useCookies(store: MockCookieStore) {
  vi.mocked(cookies).mockImplementation(async () => jarFor(store) as never);
}

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The only way a test can learn the plaintext code: `requestClaimCode`
 * never returns it past the route boundary, and the local mailer
 * (packages/adapters/src/mailer/local.ts) writes each send to its own
 * `.eml` file specifically so the e-mail path is exercised for real without
 * calling a live provider. Reads the newest file so a test that sends more
 * than one code always recovers the latest.
 */
function latestMailedCode(): string {
  // File names are a fresh nanoid per send (see local.ts), not
  // time-ordered, so "latest" has to come from the filesystem's own mtime
  // rather than from sorting the names.
  const files = readdirSync(mailRoot).filter((f) => f.endsWith(".eml"));
  const newest = files
    .map((f) => ({ f, mtimeMs: statSync(join(mailRoot, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!newest) throw new Error(`no mail was sent to ${mailRoot}`);
  const body = readFileSync(join(mailRoot, newest.f), "utf8");
  const match = body.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no 6-digit code found in mailed content: ${body}`);
  return match[1]!;
}

async function seedInvoiceWithFinding(owner: { userId?: string; sessionId?: string }, contentHash: string) {
  const issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  const ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "x" }, confidenceBase: 0.5, author: "system", reason: "fixture",
  });
  const invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({ id: invoiceId, ...owner, issuerId, contentHash, source: "pdf_text" });
  const itemId = newId("itm");
  await ctx.db.insert(invoiceItems).values({
    id: itemId, invoiceId, lineNo: 1, itemKey: "k1", description: "Item", normalizedDesc: "item", amountCents: 100,
  });
  const findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId, itemId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 100,
  });
  return { invoiceId, itemId, findingId };
}

describe("POST /api/sessions/claim", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await claim(request("/api/sessions/claim", { email: "a@example.com" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Você não tem acesso a esse item." },
    });
  });

  it("sends a mail carrying a 6-digit code and returns { ok: true }", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await claim(request("/api/sessions/claim", { email: "reader@example.com" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(latestMailedCode()).toMatch(/^\d{6}$/);
  });

  it("rejects malformed JSON the same way as findings/feedback, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const malformed = new Request("http://localhost/api/sessions/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    const response = await claim(malformed);
    expect(response.status).toBe(404);
  });

  it("rate-limits the 4th send within an hour to the same e-mail, with a Retry-After header", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    for (let i = 0; i < 3; i++) {
      const ok = await claim(request("/api/sessions/claim", { email: "busy@example.com" }));
      expect(ok.status).toBe(200);
    }
    const limited = await claim(request("/api/sessions/claim", { email: "busy@example.com" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: { code: "rate_limited", message: "Muitos envios seguidos. Aguarde um minuto." },
    });
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("does not let rotating to a different anonymous session bypass the per-e-mail limit", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    for (let i = 0; i < 3; i++) await claim(request("/api/sessions/claim", { email: "shared@example.com" }));

    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const limited = await claim(request("/api/sessions/claim", { email: "shared@example.com" }));
    expect(limited.status).toBe(429);
  });
});

describe("POST /api/sessions/claim/confirm", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await confirm(request("/api/sessions/claim/confirm", { email: "a@example.com", code: "123456" }));
    expect(response.status).toBe(403);
  });

  it("rejects a wrong code with not_found, changing nothing", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await claim(request("/api/sessions/claim", { email: "wrong@example.com" }));

    const response = await confirm(
      request("/api/sessions/claim/confirm", { email: "wrong@example.com", code: "000000" }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Não encontramos esse item." },
    });
    expect(await ctx.db.select().from(users).where(eq(users.email, "wrong@example.com"))).toHaveLength(0);
  });

  it("confirms the mailed code end to end: migrates the invoice and loses no finding", async () => {
    const { invoiceId, findingId } = await seedInvoiceWithFinding({ sessionId: sessionA }, "hash-1");

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await claim(request("/api/sessions/claim", { email: "keep@example.com" }));
    const code = latestMailedCode();

    const response = await confirm(request("/api/sessions/claim/confirm", { email: "keep@example.com", code }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [invoice] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(invoice?.sessionId).toBeNull();
    expect(invoice?.userId).toBeTruthy();

    const [finding] = await ctx.db.select().from(findings).where(eq(findings.id, findingId));
    expect(finding?.invoiceId).toBe(invoiceId); // still attached - no loss

    const [user] = await ctx.db.select().from(users).where(eq(users.email, "keep@example.com"));
    expect(user).toBeTruthy();
    const migrated = await withUser({ userId: user!.id }, ctx.db).invoices();
    expect(migrated.map((r) => r.id)).toContain(invoiceId);
  });

  it("does not let a code minted for a different session be confirmed here (INV-008)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await claim(request("/api/sessions/claim", { email: "hijack@example.com" }));
    const code = latestMailedCode();

    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const response = await confirm(request("/api/sessions/claim/confirm", { email: "hijack@example.com", code }));
    expect(response.status).toBe(404);

    const [session] = await ctx.db.select().from(anonymousSessions).where(eq(anonymousSessions.id, sessionB));
    expect(session?.claimedByUserId).toBeNull();
  });

  it("is safe to confirm twice: the second call still returns { ok: true } with no duplicate user", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await claim(request("/api/sessions/claim", { email: "twice@example.com" }));
    const code = latestMailedCode();

    const first = await confirm(request("/api/sessions/claim/confirm", { email: "twice@example.com", code }));
    const second = await confirm(request("/api/sessions/claim/confirm", { email: "twice@example.com", code }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await ctx.db.select().from(users).where(eq(users.email, "twice@example.com"))).toHaveLength(1);
  });
});
