import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { lintUserFacingText } from "@pentefino/ai";
import { newId, TELECOM_PLAYBOOK_V1, type ContestDocument } from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createLocalStorage } from "@pentefino/adapters";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";
import * as copy from "../../app/api/me/export/copy.js";

const { anonymousSessions, entitlements, events, findings, invoiceItems, invoices, issuers, rules, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { GET } = await import("../../app/api/me/export/route.js");

const SECRET = "me-export-test-secret";
const FORBIDDEN_BODY = { error: { code: "forbidden", message: "Você não tem acesso a esse item." } };

// A realistic-shaped ContestDocument: long enough to satisfy `body`'s own
// length floor, short enough to stay readable in a diff.
const SAMPLE_BODY: ContestDocument = {
  subject: "Cobrança em duplicidade na fatura",
  body:
    "Solicito a revisão da cobrança referente ao item que aparece em duplicidade na fatura deste período. " +
    "Peço a confirmação do valor correto e o registro do protocolo deste atendimento para acompanhamento.",
  requests: ["Revisar o valor cobrado", "Confirmar o protocolo do atendimento"],
  legalRefs: [{ law: "CDC", article: "Art. 42" }],
  scriptForCall: ["Pedir o número de protocolo do atendimento"],
  attachmentsChecklist: ["Fatura do período contestado"],
};

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

const alice = newId("usr");
const bob = newId("usr");
const sessionAlice = "ses_alice000000000000000"; // claimed by alice
const sessionBob = "ses_bob0000000000000000000"; // claimed by bob
const sessionUnclaimed = "ses_unclaimed0000000000000"; // never claimed by anybody

let issuerId: string;
let ruleId: string;

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));

  await ctx.db.insert(users).values([
    { id: alice, email: "alice@example.com" },
    { id: bob, email: "bob@example.com" },
  ]);
  await ctx.db.insert(anonymousSessions).values([
    { id: sessionAlice, claimedByUserId: alice, expiresAt: new Date(Date.now() + 60 * 60_000) },
    { id: sessionBob, claimedByUserId: bob, expiresAt: new Date(Date.now() + 60 * 60_000) },
    { id: sessionUnclaimed, claimedByUserId: null, expiresAt: new Date(Date.now() + 60 * 60_000) },
  ]);

  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({
    id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro", playbook: TELECOM_PLAYBOOK_V1,
  });
  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5,
    author: "system", reason: "test fixture",
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

function request(): Request {
  return new Request("http://localhost/api/me/export", { method: "GET" });
}

/**
 * Writes bytes straight to the storage root's filesystem path for `key`,
 * bypassing `signUpload`/`put` entirely - the same choice
 * `apps/jobs/test/ingest.test.ts` makes and documents for the same reason:
 * those two enforce a real content-hash and sniffed-MIME match against
 * whatever gets written, and this fixture only needs the resulting object's
 * *presence* under `storage.exists`/`signDownload`, never the upload
 * contract itself.
 */
function seedStorageObject(storageRoot: string, key: string, body: string | Uint8Array = "fake pdf bytes") {
  const target = join(storageRoot, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

/**
 * One full "account's worth" of rows: an invoice with a real, retained file
 * in storage; a second, already-expired-under-RF-110 invoice (fileKey
 * cleared, fileExpiresAt stamped); an item and a finding on the first
 * invoice; a case built from that finding (writes case_created); a case
 * document; a protocol (writes protocol_entered, moves the case to sac); and
 * an entitlement. Returns every id a test needs to assert on.
 */
async function seedFullAccount(userId: string) {
  const retainedInvoiceId = newId("inv");
  // Same shape `createLocalStorage`'s own `signUpload` mints
  // (`uploads/<owner>/<hash>.<ext>`) - `signDownload` refuses anything else.
  const fileKey = `uploads/${userId}/${retainedInvoiceId}.pdf`;
  seedStorageObject(storageRoot, fileKey);
  await ctx.db.insert(invoices).values({
    id: retainedInvoiceId, userId, issuerId, contentHash: `hash-${retainedInvoiceId}`,
    source: "pdf_text", status: "analyzed", fileKey,
  });

  const expiredInvoiceId = newId("inv");
  const expiredAt = new Date("2026-01-01T00:00:00.000Z");
  await ctx.db.insert(invoices).values({
    id: expiredInvoiceId, userId, issuerId, contentHash: `hash-${expiredInvoiceId}`,
    source: "pdf_text", status: "analyzed", fileKey: null, fileExpiresAt: expiredAt,
  });

  const itemId = newId("itm");
  await ctx.db.insert(invoiceItems).values({
    id: itemId, invoiceId: retainedInvoiceId, lineNo: 1, itemKey: "k1",
    description: "Item de teste", normalizedDesc: "item de teste", amountCents: 100,
  });
  const findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId: retainedInvoiceId, itemId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 100,
  });

  const scoped = withUser({ userId }, ctx.db);
  const caseId = (await scoped.createCase({ invoiceId: retainedInvoiceId, findingIds: [findingId] }))!;
  const docId = (await scoped.createCaseDocument({
    caseId, stage: "draft", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
  }))!;
  await scoped.recordProtocol(caseId, {
    stage: "sac", protocolNumber: `prt-${userId}`, channel: "SAC da operadora", registeredAt: new Date(),
  });
  const entitlementId = newId("ent");
  await ctx.db.insert(entitlements).values({ id: entitlementId, userId, plan: "premium", source: "manual" });

  return { retainedInvoiceId, expiredInvoiceId, fileKey, itemId, findingId, caseId, docId, entitlementId };
}

describe("GET /api/me/export (RF-242)", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(FORBIDDEN_BODY);
  });

  it("returns forbidden, with no body containing any row, for an anonymous (never-claimed) session", async () => {
    await seedFullAccount(alice);
    useCookies(createCookieStore({ pf_session: signSession(sessionUnclaimed, SECRET) }));

    const response = await GET(request());
    expect(response.status).toBe(403);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual(FORBIDDEN_BODY);
    expect(raw).not.toContain(alice);
    expect(raw).not.toContain("alice@example.com");
  });

  it("records no data_exported event for an anonymous session", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionUnclaimed, SECRET) }));
    await GET(request());
    const rows = await ctx.db.select().from(events).where(eq(events.type, "data_exported"));
    expect(rows).toHaveLength(0);
  });

  it("returns the complete bundle, the aviso, and the right headers for the caller's own account", async () => {
    const seeded = await seedFullAccount(alice);
    useCookies(createCookieStore({ pf_session: signSession(sessionAlice, SECRET) }));

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.formatVersion).toBe(1);
    expect(body.aviso).toBe(copy.AVISO);
    expect(body.account).toMatchObject({ id: alice, email: "alice@example.com" });
    expect(body.invoices.map((r: { id: string }) => r.id).sort()).toEqual(
      [seeded.retainedInvoiceId, seeded.expiredInvoiceId].sort(),
    );
    expect(body.invoiceItems.map((r: { id: string }) => r.id)).toContain(seeded.itemId);
    expect(body.findings.map((r: { id: string }) => r.id)).toContain(seeded.findingId);
    expect(body.cases.map((r: { id: string }) => r.id)).toContain(seeded.caseId);
    expect(body.caseDocuments.map((r: { id: string }) => r.id)).toContain(seeded.docId);
    expect(body.caseProtocols.some((r: { caseId: string }) => r.caseId === seeded.caseId)).toBe(true);
    expect(body.entitlements.map((r: { id: string }) => r.id)).toContain(seeded.entitlementId);
    expect(body.events.some((e: { type: string }) => e.type === "case_created")).toBe(true);
    expect(Array.isArray(body.files)).toBe(true);
  });

  it("records exactly one data_exported event, after the bundle was already built", async () => {
    await seedFullAccount(alice);
    useCookies(createCookieStore({ pf_session: signSession(sessionAlice, SECRET) }));

    const response = await GET(request());
    expect(response.status).toBe(200);

    const rows = await ctx.db.select().from(events)
      .where(and(eq(events.userId, alice), eq(events.type, "data_exported")));
    expect(rows).toHaveLength(1);
  });

  // --- INV-008, the load-bearing test of this file. Asserted on the raw
  // serialised response text, not on array lengths: a length check cannot
  // see an id smuggled into a nested field, which is exactly what a leak
  // through a wrongly-scoped ownership filter would look like.
  it("never includes another user's rows anywhere in the serialised response", async () => {
    const seededBob = await seedFullAccount(bob);
    const seededAlice = await seedFullAccount(alice);
    useCookies(createCookieStore({ pf_session: signSession(sessionAlice, SECRET) }));

    const response = await GET(request());
    const raw = await response.text();

    expect(response.status).toBe(200);
    // Sanity: this is not a false pass from an empty export.
    expect(raw).toContain(seededAlice.retainedInvoiceId);
    expect(raw).toContain(seededAlice.caseId);

    for (const leaked of [
      bob, "bob@example.com",
      seededBob.retainedInvoiceId, seededBob.expiredInvoiceId, seededBob.itemId, seededBob.findingId,
      seededBob.caseId, seededBob.docId, seededBob.entitlementId,
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });

  it("gives a retained file a signed link whose verifyDownload says valid, refused after the TTL passes", async () => {
    const clock = { now: Date.now() };
    const storage = createLocalStorage({ root: storageRoot, secret: "test-upload-secret", now: () => clock.now });
    vi.mocked(container).mockReturnValue({ ...buildTestContainer({ db: ctx.db, storageRoot, mailRoot }), storage });

    const seeded = await seedFullAccount(alice);
    useCookies(createCookieStore({ pf_session: signSession(sessionAlice, SECRET) }));

    const response = await GET(request());
    const body = await response.json();
    const fileEntry = body.files.find(
      (f: { source: string; invoiceId?: string }) => f.source === "invoice" && f.invoiceId === seeded.retainedInvoiceId,
    );
    expect(fileEntry).toBeDefined();
    expect(fileEntry.url).toEqual(expect.any(String));
    expect(fileEntry.deletedAt).toBeUndefined();

    const validNow = storage.verifyDownload(fileEntry.url);
    expect(validNow).toMatchObject({ valid: true });

    // 15 minutes and one second later - past DOWNLOAD_TTL_MS.
    clock.now += 15 * 60 * 1000 + 1000;
    const expired = storage.verifyDownload(fileEntry.url);
    expect(expired).toMatchObject({ valid: false, reason: "expired" });
  });

  it("gives an already-expired invoice the deleted-on marker and no link", async () => {
    const seeded = await seedFullAccount(alice);
    useCookies(createCookieStore({ pf_session: signSession(sessionAlice, SECRET) }));

    const response = await GET(request());
    const body = await response.json();
    const fileEntry = body.files.find(
      (f: { source: string; invoiceId?: string }) => f.source === "invoice" && f.invoiceId === seeded.expiredInvoiceId,
    );

    expect(fileEntry).toBeDefined();
    expect(fileEntry.url).toBeUndefined();
    expect(fileEntry.deletedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("gives no file entry at all for an invoice that never had a stored file", async () => {
    const csvInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: csvInvoiceId, userId: alice, issuerId, contentHash: `hash-${csvInvoiceId}`,
      source: "csv", status: "analyzed", fileKey: null,
    });
    useCookies(createCookieStore({ pf_session: signSession(sessionAlice, SECRET) }));

    const response = await GET(request());
    const body = await response.json();
    expect(body.invoices.map((r: { id: string }) => r.id)).toContain(csvInvoiceId);
    expect(
      body.files.some((f: { invoiceId?: string }) => f.invoiceId === csvInvoiceId),
    ).toBe(false);
  });
});

describe("copy (INV-004/INV-005)", () => {
  it("every user-facing string this route can produce passes lintUserFacingText", () => {
    for (const text of [copy.AVISO]) {
      const result = lintUserFacingText(text);
      expect(result.ok, `"${text}" violated: ${JSON.stringify(result.violations)}`).toBe(true);
    }
  });

  it("states the links' TTL in minutes, in Portuguese, without a legal-sounding promise", () => {
    expect(copy.AVISO).toMatch(/\d+ minutos/);
    expect(copy.AVISO.toLowerCase()).not.toContain("garant");
  });
});
