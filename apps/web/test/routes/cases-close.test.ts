import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
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
const { POST } = await import("../../app/api/cases/[id]/close/route.js");

const SECRET = "cases-close-test-secret";

const NOT_FOUND_BODY = { error: { code: "not_found", message: "Não encontramos esse item." } };
const FORBIDDEN_BODY = { error: { code: "forbidden", message: "Você não tem acesso a esse item." } };

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

const alice = newId("usr");
const bob = newId("usr");
const sessionA = "ses_owner00000000000000"; // claimed by alice
const sessionB = "ses_other00000000000000"; // claimed by bob

let issuerId: string;
let ruleId: string;
let aliceCaseId: string;

async function seedCaseFor(userId: string): Promise<string> {
  const invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, userId, issuerId, contentHash: `hash-${invoiceId}`, source: "pdf_text", status: "analyzed",
  });
  const findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1_000,
  });
  return (await withUser({ userId }, ctx.db).createCase({ invoiceId, findingIds: [findingId] }))!;
}

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

  aliceCaseId = await seedCaseFor(alice);
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

function request(caseId: string, body: unknown): Request {
  return new Request(`http://localhost/api/cases/${caseId}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const caseRow = (caseId: string) => ctx.db.select().from(cases).where(eq(cases.id, caseId));
const closeEvents = (caseId: string) => ctx.db.select().from(events)
  .where(and(eq(events.caseId, caseId), eq(events.type, "outcome_confirmed")));

describe("POST /api/cases/[id]/close", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await POST(
      request(aliceCaseId, { outcome: "resolved", recoveredCents: 5_000 }),
      ctxFor(aliceCaseId),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(FORBIDDEN_BODY);
  });

  it("closes the caller's own case and stamps the outcome the north-star metric is computed from", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(
      request(aliceCaseId, { outcome: "resolved", recoveredCents: 12_345, note: "Estorno confirmado." }),
      ctxFor(aliceCaseId),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [row] = await caseRow(aliceCaseId);
    expect(row).toMatchObject({
      outcome: "resolved",
      outcomeConfirmedBy: "user",
      recoveredCents: 12_345,
      stage: "closed",
    });
    expect(row?.closedAt).toBeInstanceOf(Date);
  });

  it("records exactly one outcome_confirmed event, and the route adds none of its own", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    await POST(request(aliceCaseId, { outcome: "partial", recoveredCents: 4_200 }), ctxFor(aliceCaseId));

    // The count, not merely "one exists": `closeCase` writes this row inside
    // its own transaction, so a route that recorded it too would produce two
    // and double-count §1.4's north-star metric. Only a count catches that.
    const recorded = await closeEvents(aliceCaseId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({
      outcome: "partial", recoveredCents: 4_200, confirmedBy: "user",
    });
  });

  it("rejects a second close and leaves the first close's values untouched", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    await POST(request(aliceCaseId, { outcome: "resolved", recoveredCents: 9_900 }), ctxFor(aliceCaseId));

    const second = await POST(
      request(aliceCaseId, { outcome: "denied", recoveredCents: 0 }),
      ctxFor(aliceCaseId),
    );

    expect(second.status).toBe(404);
    expect(await second.json()).toEqual(NOT_FOUND_BODY);

    const [row] = await caseRow(aliceCaseId);
    expect(row).toMatchObject({ outcome: "resolved", recoveredCents: 9_900 });
    expect(await closeEvents(aliceCaseId)).toHaveLength(1);
  });

  it("returns the same body for another user's case as for a case that does not exist", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));

    const otherResponse = await POST(
      request(aliceCaseId, { outcome: "resolved", recoveredCents: 5_000 }),
      ctxFor(aliceCaseId),
    );
    const missingId = newId("cas");
    const missingResponse = await POST(
      request(missingId, { outcome: "resolved", recoveredCents: 5_000 }),
      ctxFor(missingId),
    );

    expect(otherResponse.status).toBe(404);
    expect(await otherResponse.json()).toEqual(await missingResponse.json());

    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
    expect(row?.outcome).toBeNull();
  });

  // --- §1.4's north-star metric is "reais recuperados confirmados por
  // usuário ativo/mês". A favourable outcome whose amount nobody recorded is
  // money the metric silently loses; an unfavourable one carrying a positive
  // amount is money it silently invents.

  it("rejects a resolved outcome with no recoveredCents", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(request(aliceCaseId, { outcome: "resolved" }), ctxFor(aliceCaseId));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });

  it("rejects a partial outcome with no recoveredCents", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(request(aliceCaseId, { outcome: "partial" }), ctxFor(aliceCaseId));

    expect(response.status).toBe(404);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });

  it("rejects a denied outcome carrying a positive recoveredCents", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(
      request(aliceCaseId, { outcome: "denied", recoveredCents: 5_000 }),
      ctxFor(aliceCaseId),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });

  it("rejects an abandoned outcome carrying a positive recoveredCents", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(
      request(aliceCaseId, { outcome: "abandoned", recoveredCents: 1 }),
      ctxFor(aliceCaseId),
    );

    expect(response.status).toBe(404);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });

  // The rule is "no *positive* amount", not "no amount": an explicit zero is
  // an honest statement that nothing came back, and must still close.
  it("accepts a denied outcome carrying an explicit zero", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(
      request(aliceCaseId, { outcome: "denied", recoveredCents: 0 }),
      ctxFor(aliceCaseId),
    );

    expect(response.status).toBe(200);
    const [row] = await caseRow(aliceCaseId);
    expect(row).toMatchObject({ outcome: "denied", recoveredCents: 0, stage: "closed" });
  });

  // Money is integer cents, always. `closeCase` *throws* on a fractional or
  // negative value rather than returning null, so a route that let one
  // through would answer 500 - or, for a value the column rejects, a raw
  // database error. These must be 404s decided before the call.

  it("rejects a fractional recoveredCents as not_found, never a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(
      request(aliceCaseId, { outcome: "resolved", recoveredCents: 12.5 }),
      ctxFor(aliceCaseId),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });

  it("rejects a negative recoveredCents as not_found, never a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(
      request(aliceCaseId, { outcome: "resolved", recoveredCents: -5_000 }),
      ctxFor(aliceCaseId),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });

  it("rejects an outcome outside CASE_OUTCOMES", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const response = await POST(
      request(aliceCaseId, { outcome: "won", recoveredCents: 5_000 }),
      ctxFor(aliceCaseId),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });

  // `note` had a 2 000-character cap and no test at all, which is the same
  // thing as no cap: nothing downstream bounds it either. `closeCase` puts
  // the note into `events.payload`, a `jsonb` column with no length limit,
  // so an unbounded string is persisted verbatim, forever, on a row every
  // read of the case's timeline carries back out. The pair below is what
  // makes the number real - one over is refused, the cap itself is accepted,
  // so neither deleting the `.max()` nor lowering it can stay unnoticed.
  it("rejects a note longer than the cap, and accepts one exactly at it", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));

    const overCap = await POST(
      request(aliceCaseId, { outcome: "resolved", recoveredCents: 5_000, note: "a".repeat(2_001) }),
      ctxFor(aliceCaseId),
    );

    expect(overCap.status).toBe(404);
    expect(await overCap.json()).toEqual(NOT_FOUND_BODY);
    const [stillOpen] = await caseRow(aliceCaseId);
    expect(stillOpen?.closedAt).toBeNull();
    expect(await closeEvents(aliceCaseId)).toHaveLength(0);

    const atCap = await POST(
      request(aliceCaseId, { outcome: "resolved", recoveredCents: 5_000, note: "a".repeat(2_000) }),
      ctxFor(aliceCaseId),
    );
    expect(atCap.status).toBe(200);
  });

  it("rejects malformed JSON the same way, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const malformed = new Request(`http://localhost/api/cases/${aliceCaseId}/close`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });

    const response = await POST(malformed, ctxFor(aliceCaseId));

    expect(response.status).toBe(404);
    const [row] = await caseRow(aliceCaseId);
    expect(row?.closedAt).toBeNull();
  });
});
