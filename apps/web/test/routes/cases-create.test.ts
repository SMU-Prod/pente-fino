import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, cases, events, findings, invoices, issuers, rules, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { POST } = await import("../../app/api/cases/route.js");

const SECRET = "cases-create-test-secret";

const NOT_FOUND_BODY = { error: { code: "not_found", message: "Não encontramos esse item." } };
const FORBIDDEN_BODY = { error: { code: "forbidden", message: "Você não tem acesso a esse item." } };

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

const alice = newId("usr");
const bob = newId("usr");
const sessionA = "ses_owner00000000000000"; // claimed by alice
const sessionB = "ses_other00000000000000"; // claimed by bob
const sessionAnon = "ses_anon0000000000000000"; // never claimed

let issuerId: string;
let ruleId: string;
let aliceInvoice: string;
let bobInvoice: string;
let anonInvoice: string;
let aliceFinding: string;
let aliceFinding2: string;
let bobFinding: string;
let anonFinding: string;

async function seedInvoice(db: TestDb["db"], owner: { userId?: string; sessionId?: string }) {
  const id = newId("inv");
  await db.insert(invoices).values({
    id, ...owner, issuerId, contentHash: `hash-${id}`, source: "pdf_text", status: "analyzed",
  });
  return id;
}

async function seedFinding(db: TestDb["db"], invoiceId: string) {
  const id = newId("fnd");
  await db.insert(findings).values({
    id, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1_000,
  });
  return id;
}

// Scoped to the user under test rather than reading the whole table:
// `createTestDb` runs `seedAll`, and a seed that one day ships a case would
// otherwise turn these assertions red for a reason that is not this route's.
const casesOf = (userId: string) => ctx.db.select().from(cases).where(eq(cases.userId, userId));

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
    { id: sessionA, claimedByUserId: alice, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionB, claimedByUserId: bob, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionAnon, expiresAt: new Date(Date.now() + 60_000) },
  ]);

  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5,
    author: "system", reason: "test fixture",
  });

  aliceInvoice = await seedInvoice(ctx.db, { userId: alice });
  bobInvoice = await seedInvoice(ctx.db, { userId: bob });
  // The anonymous session gets a real invoice and a real finding of its own,
  // so test 6 is about ownership *resolution* - `cases.userId` is NOT NULL,
  // so a bare session can never own a case - and not about a session that
  // simply happens to own nothing.
  anonInvoice = await seedInvoice(ctx.db, { sessionId: sessionAnon });

  aliceFinding = await seedFinding(ctx.db, aliceInvoice);
  aliceFinding2 = await seedFinding(ctx.db, aliceInvoice);
  bobFinding = await seedFinding(ctx.db, bobInvoice);
  anonFinding = await seedFinding(ctx.db, anonInvoice);
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
  return new Request("http://localhost/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/cases", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await POST(request({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(FORBIDDEN_BODY);
  });

  it("opens the caller's own case at draft with no deadline, stamped with the invoice's issuer", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(request({ invoiceId: aliceInvoice, findingIds: [aliceFinding, aliceFinding2] }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ caseId: expect.any(String) });

    const [row] = await ctx.db.select().from(cases).where(eq(cases.id, body.caseId));
    expect(row).toMatchObject({
      userId: alice,
      invoiceId: aliceInvoice,
      issuerId,
      findingIds: [aliceFinding, aliceFinding2],
      // §9.1: a case opens at `draft`. `protocol_entered` is what moves it
      // to `sac` (E5 Task 5's route), so nothing is due yet.
      stage: "draft",
      nextDeadlineAt: null,
    });
  });

  it("records exactly one case_created event, and the route adds none of its own", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await POST(request({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }));
    const { caseId } = await response.json();

    // The count, not merely "one exists": `createCase` writes this row inside
    // its own transaction (principle A3), so a route that also recorded it
    // would produce two and only a count catches that.
    const created = await ctx.db.select().from(events)
      .where(and(eq(events.caseId, caseId), eq(events.type, "case_created")));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ caseId, invoiceId: aliceInvoice, userId: alice });
    expect(created[0]?.payload).toMatchObject({ invoiceId: aliceInvoice });

    // No other event type either: this route records nothing itself.
    const all = await ctx.db.select().from(events).where(eq(events.caseId, caseId));
    expect(all.map((e) => e.type)).toEqual(["case_created"]);
  });

  // --- INV-008 at the HTTP layer: the smuggling case. A caller who owns one
  // invoice must not be able to name somebody else's finding alongside their
  // own and have the case take it.

  it("rejects a findingIds array that smuggles another user's finding in beside the caller's own", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(request({
      invoiceId: aliceInvoice,
      findingIds: [aliceFinding, bobFinding],
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);

    expect(await casesOf(alice)).toHaveLength(0);

    const [smuggled] = await ctx.db.select().from(findings).where(eq(findings.id, bobFinding));
    expect(smuggled?.status).toBe("open"); // never flipped to `contested`
    const [own] = await ctx.db.select().from(findings).where(eq(findings.id, aliceFinding));
    expect(own?.status).toBe("open"); // nor was the caller's own, since nothing was created
  });

  it("returns the same body for another user's invoice as for an invoice that does not exist", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const otherResponse = await POST(request({ invoiceId: bobInvoice, findingIds: [bobFinding] }));
    const missingResponse = await POST(request({ invoiceId: newId("inv"), findingIds: [newId("fnd")] }));

    expect(otherResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(await otherResponse.json()).toEqual(await missingResponse.json());

    expect(await casesOf(alice)).toHaveLength(0);
    expect(await casesOf(bob)).toHaveLength(0);
  });

  // --- `cases.userId` is NOT NULL: an anonymous session can never own a
  // case, so it gets `not_found` - never `forbidden` (the cookie is valid),
  // and never a 500 (the NOT NULL must be caught before the INSERT).

  it("treats a valid but never-claimed anonymous session as not_found, not forbidden and not a crash", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionAnon, SECRET) }));

    const response = await POST(request({ invoiceId: anonInvoice, findingIds: [anonFinding] }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);

    const rows = await ctx.db.select().from(cases).where(eq(cases.invoiceId, anonInvoice));
    expect(rows).toHaveLength(0);
    const [untouched] = await ctx.db.select().from(findings).where(eq(findings.id, anonFinding));
    expect(untouched?.status).toBe("open");
  });

  it("rejects malformed JSON the same way, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const malformed = new Request("http://localhost/api/cases", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });

    const response = await POST(malformed);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  it("rejects an empty findingIds array, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(request({ invoiceId: aliceInvoice, findingIds: [] }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    expect(await casesOf(alice)).toHaveLength(0);
  });

  it("rejects a missing invoiceId, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(request({ findingIds: [aliceFinding] }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    expect(await casesOf(alice)).toHaveLength(0);
  });

  // Every rejection above is one `createCase` would refuse on its own -
  // measured, not assumed: with this route's zod check removed, all of them
  // stay green. So none of them can tell whether the route still validates
  // anything at all. These can. A body whose *types* are wrong never reaches
  // a rejection the db layer has an answer for; it reaches a query builder
  // that binds whatever it was handed, and the driver throws out of the
  // route as a 500. That is what the schema actually buys.
  //
  // Of the four shapes below, the object is the one that reaches the driver
  // today ("Invalid input for string type", thrown from pglite's serialize)
  // and therefore the one that goes red if the schema is deleted; a number,
  // a null and a bare string are all coerced by the driver as things stand.
  // They are kept because the property asserted is the same one, and which
  // shapes a driver happens to tolerate is not a thing this route should
  // depend on.
  it.each([
    ["a null inside findingIds", { invoiceId: "PLACEHOLDER", findingIds: [null] }],
    ["a number where invoiceId belongs", { invoiceId: 12_345, findingIds: ["PLACEHOLDER"] }],
    ["a string where findingIds belongs", { invoiceId: "PLACEHOLDER", findingIds: "not-an-array" }],
    ["an object where invoiceId belongs", { invoiceId: { toString: "x" }, findingIds: ["PLACEHOLDER"] }],
  ])("rejects %s with not_found, never a 500 or a database error", async (_label, template) => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const body = JSON.parse(
      JSON.stringify(template).replaceAll('"PLACEHOLDER"', JSON.stringify(aliceInvoice)),
    );
    if (Array.isArray(body.findingIds)) {
      body.findingIds = body.findingIds.map((v: unknown) => (v === aliceInvoice ? aliceFinding : v));
    }

    const response = await POST(request(body));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    expect(await casesOf(alice)).toHaveLength(0);
  });

  it("rejects more findingIds than one contestation can plausibly name, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(request({
      invoiceId: aliceInvoice,
      findingIds: Array.from({ length: 201 }, () => newId("fnd")),
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });
});
