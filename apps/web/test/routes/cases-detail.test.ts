import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { containsPii, newId } from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, cases, events, findings, invoices, issuers, rules, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { GET } = await import("../../app/api/cases/[id]/route.js");

const SECRET = "cases-detail-test-secret";

const FORBIDDEN_BODY = { error: { code: "forbidden", message: "Você não tem acesso a esse item." } };

// A CPF with valid check digits - `packages/core/src/invoice/mask.ts` only
// treats an unlabelled run as PII when the digits actually check out, so a
// made-up number would make this test pass for the wrong reason.
const REAL_CPF = "123.456.789-09";

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

const alice = newId("usr");
const bob = newId("usr");
const sessionA = "ses_owner00000000000000"; // claimed by alice
const sessionB = "ses_other00000000000000"; // claimed by bob

let issuerId: string;
let ruleId: string;
let aliceInvoice: string;
let aliceFinding: string;
let aliceCaseId: string;

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
    { id: sessionA, claimedByUserId: alice, expiresAt: new Date(Date.now() + 60 * 60_000) },
    { id: sessionB, claimedByUserId: bob, expiresAt: new Date(Date.now() + 60 * 60_000) },
  ]);

  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5,
    author: "system", reason: "test fixture",
  });

  aliceInvoice = newId("inv");
  await ctx.db.insert(invoices).values({
    id: aliceInvoice, userId: alice, issuerId,
    contentHash: `hash-${aliceInvoice}`, source: "pdf_text", status: "analyzed",
  });
  aliceFinding = newId("fnd");
  await ctx.db.insert(findings).values({
    id: aliceFinding, invoiceId: aliceInvoice, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1_000,
  });

  aliceCaseId = (await withUser({ userId: alice }, ctx.db)
    .createCase({ invoiceId: aliceInvoice, findingIds: [aliceFinding] }))!;
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

function ctxFor(caseId: string) {
  return { params: Promise.resolve({ id: caseId }) };
}

function request(caseId: string): Request {
  return new Request(`http://localhost/api/cases/${caseId}`, { method: "GET" });
}

describe("GET /api/cases/[id]", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(FORBIDDEN_BODY);
  });

  it("returns exactly §8.2's four keys for the caller's own case", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["case", "documents", "protocols", "timeline"]);
    expect(body.case).toMatchObject({ id: aliceCaseId, invoiceId: aliceInvoice, stage: "draft" });
    expect(body.documents).toEqual([]);
    expect(body.protocols).toEqual([]);
  });

  // `cases.protocol_token` is the workflow's `wait.forToken` handle: whoever
  // holds it can resume the run this case is waiting on. Nothing in this
  // response consumes it, and E5 Tasks 3 and 5 read it server-side from the
  // row itself, so it has no reason to cross into a browser at all. The
  // token is seeded with a value that could not appear by coincidence and
  // checked against the *raw* body rather than the parsed `case` object, so
  // a copy of it reaching the response some other way - a timeline payload,
  // a generated document - fails this too.
  it("never serialises the case's protocolToken", async () => {
    const token = "wtk_do_not_ship_this_token_to_a_browser";
    await ctx.db.update(cases).set({ protocolToken: token }).where(eq(cases.id, aliceCaseId));

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).case).not.toHaveProperty("protocolToken");
    // The rest of the case still comes back - this is a stripped field, not
    // a stripped object.
    expect(JSON.parse(raw).case).toMatchObject({ id: aliceCaseId, invoiceId: aliceInvoice, stage: "draft" });
  });

  it("returns the timeline in chronological order, carrying the case_created event written at creation", async () => {
    // Inserted *after* the case exists but stamped *before* it: a timeline
    // that came back in insertion order would put this last. Only an order
    // on `occurredAt` puts it first - which is what a person reading their
    // own case screen needs, and what `caseDetail`'s `(occurredAt, id)`
    // ordering guarantees even when two rows share an instant. (E5 Task 7's
    // dossier orders the same way, but assembles its own wider query rather
    // than calling this route - see the route's doc comment.)
    const [created] = await ctx.db.select().from(events)
      .where(and(eq(events.caseId, aliceCaseId), eq(events.type, "case_created")));
    await ctx.db.insert(events).values({
      id: newId("evt"), userId: alice, invoiceId: aliceInvoice, caseId: aliceCaseId,
      type: "contest_generated", payload: {},
      occurredAt: new Date(created!.occurredAt.getTime() - 60_000),
    });

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    const body = await response.json();

    expect(body.timeline.map((e: { type: string }) => e.type)).toEqual(["contest_generated", "case_created"]);
    const times = body.timeline.map((e: { occurredAt: string }) => Date.parse(e.occurredAt));
    expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
  });

  it("returns a byte-identical response for another user's case as for a case that does not exist", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));

    const otherResponse = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    const missingId = newId("cas");
    const missingResponse = await GET(request(missingId), ctxFor(missingId));

    expect(otherResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(await otherResponse.text()).toEqual(await missingResponse.text());
  });

  // --- INV-007. The one place free text a person typed reaches this
  // response is the close note, which `closeCase` masks on the way into
  // `events.payload`. This proves the whole serialised body is clean, and -
  // by checking the marker is actually there - that it is clean because the
  // note was masked, not because the note never arrived.

  it("returns no unmasked PII, including a CPF typed into a close note (INV-007)", async () => {
    await withUser({ userId: alice }, ctx.db).closeCase(aliceCaseId, {
      outcome: "resolved",
      recoveredCents: 12_345,
      note: `A operadora confirmou o estorno. Meu CPF ${REAL_CPF} consta no protocolo.`,
    });

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain(REAL_CPF);
    expect(raw).toContain("[CPF]"); // the note did arrive - masked, not dropped
    expect(containsPii(raw)).toBe(false);
  });

  // --- RF-185. Reminder suppression needs a durable "this case was opened"
  // fact to read; `case_viewed` (packages/core/src/events.ts) is that fact,
  // and this route is where it must be recorded - see the route's doc
  // comment for why report_viewed cannot serve the same purpose.

  it("records exactly one case_viewed row, carrying this case's caseId and invoiceId, on a successful GET", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    expect(response.status).toBe(200);

    // `createCase` (in beforeEach) already wrote a `case_created` row, so
    // filter on type rather than asserting a bare row count for the case.
    const rows = await ctx.db.select().from(events)
      .where(and(eq(events.caseId, aliceCaseId), eq(events.type, "case_viewed")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ caseId: aliceCaseId, invoiceId: aliceInvoice, payload: {} });
  });

  it("records a second case_viewed row on a second GET, because RF-185 reads the latest view and must not be deduplicated", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    await GET(request(aliceCaseId), ctxFor(aliceCaseId));

    const rows = await ctx.db.select().from(events)
      .where(and(eq(events.caseId, aliceCaseId), eq(events.type, "case_viewed")));
    expect(rows).toHaveLength(2);
  });

  it("records no case_viewed row for another user's case (404), and leaves the victim's timeline unchanged (INV-008)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    expect(response.status).toBe(404);

    const rows = await ctx.db.select().from(events)
      .where(and(eq(events.caseId, aliceCaseId), eq(events.type, "case_viewed")));
    expect(rows).toHaveLength(0);
    const types = await ctx.db.select({ type: events.type }).from(events)
      .where(eq(events.caseId, aliceCaseId));
    expect(types.map((row) => row.type)).toEqual(["case_created"]);
  });

  it("records no case_viewed row with no session cookie (403)", async () => {
    useCookies(createCookieStore());
    const response = await GET(request(aliceCaseId), ctxFor(aliceCaseId));
    expect(response.status).toBe(403);

    const rows = await ctx.db.select().from(events)
      .where(and(eq(events.caseId, aliceCaseId), eq(events.type, "case_viewed")));
    expect(rows).toHaveLength(0);
  });
});
