import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { computeDeadline, newId, TELECOM_PLAYBOOK_V1 } from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, caseProtocols, cases, events, findings, invoices, issuers, rules, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { POST: protocolPOST } = await import("../../app/api/cases/[id]/protocol/route.js");
const { POST: advancePOST } = await import("../../app/api/cases/[id]/advance/route.js");

const SECRET = "cases-protocol-test-secret";

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
  await ctx.db.insert(issuers).values({
    id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro",
    playbook: TELECOM_PLAYBOOK_V1,
  });
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

function signedIn() {
  useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
}

function ctxFor(caseId: string) {
  return { params: Promise.resolve({ id: caseId }) };
}

function request(caseId: string, path: string, body: unknown): Request {
  return new Request(`http://localhost/api/cases/${caseId}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const caseRow = async (caseId: string) =>
  (await ctx.db.select().from(cases).where(eq(cases.id, caseId)))[0];
const protocolsOf = (caseId: string) =>
  ctx.db.select().from(caseProtocols).where(eq(caseProtocols.caseId, caseId));
const eventsOf = (caseId: string, type: string) =>
  ctx.db.select().from(events).where(and(eq(events.caseId, caseId), eq(events.type, type)));

const REGISTERED_AT = "2026-08-05T15:00:00.000Z";

function validProtocol(overrides: Record<string, unknown> = {}) {
  return {
    stage: "sac",
    protocolNumber: "2026080512345",
    channel: "SAC da operadora",
    registeredAt: REGISTERED_AT,
    ...overrides,
  };
}

describe("POST /api/cases/[id]/protocol", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await protocolPOST(request(aliceCaseId, "protocol", validProtocol()), ctxFor(aliceCaseId));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(FORBIDDEN_BODY);
  });

  it("records the protocol and answers with §8.2's { nextDeadlineAt }", async () => {
    signedIn();
    const response = await protocolPOST(request(aliceCaseId, "protocol", validProtocol()), ctxFor(aliceCaseId));
    expect(response.status).toBe(200);
    const expected = computeDeadline({
      startedAt: new Date(REGISTERED_AT), days: 7, businessDays: false,
    }).expiresAt;
    expect(await response.json()).toEqual({ nextDeadlineAt: expected.toISOString() });
  });

  // RF-184's acceptance. The wait is released by THIS request, not by the
  // next sweep: no scheduled job runs in this test, and the row already
  // carries the new stage and deadline the moment the response resolves.
  it("has released the wait by the time it responds, with no scheduled job involved", async () => {
    signedIn();
    const startedAt = Date.now();
    const response = await protocolPOST(request(aliceCaseId, "protocol", validProtocol()), ctxFor(aliceCaseId));
    const elapsedMs = Date.now() - startedAt;
    const body = await response.json() as { nextDeadlineAt: string };

    const row = await caseRow(aliceCaseId);
    expect(row?.stage).toBe("sac");
    expect(row?.nextDeadlineAt?.toISOString()).toBe(body.nextDeadlineAt);
    expect(elapsedMs).toBeLessThan(30_000);
  });

  it("writes the case_protocols row and the events, and nothing twice", async () => {
    signedIn();
    await protocolPOST(request(aliceCaseId, "protocol", validProtocol()), ctxFor(aliceCaseId));
    const protocols = await protocolsOf(aliceCaseId);
    expect(protocols).toHaveLength(1);
    expect(protocols[0]).toMatchObject({ stage: "sac", protocolNumber: "2026080512345" });
    expect(await eventsOf(aliceCaseId, "protocol_entered")).toHaveLength(1);
    expect(await eventsOf(aliceCaseId, "stage_advanced")).toHaveLength(1);
  });

  // INV-008: the one bit of information every rejection has to withhold is
  // whether the id exists at all.
  it("answers a foreign case exactly as it answers one that never existed", async () => {
    signedIn();
    const bobCaseId = await seedCaseFor(bob);
    const foreign = await protocolPOST(request(bobCaseId, "protocol", validProtocol()), ctxFor(bobCaseId));
    const missing = await protocolPOST(request("cas_nope", "protocol", validProtocol()), ctxFor("cas_nope"));
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(await foreign.json().catch(() => NOT_FOUND_BODY)).toBeTruthy();
    expect(await protocolsOf(bobCaseId)).toEqual([]);
  });

  it("returns not_found for a stale stage, without writing anything", async () => {
    signedIn();
    const response = await protocolPOST(
      request(aliceCaseId, "protocol", validProtocol({ stage: "consumidor_gov" })),
      ctxFor(aliceCaseId),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    expect(await protocolsOf(aliceCaseId)).toEqual([]);
  });

  // Every one of these is a body the route must refuse, asserted one by one
  // rather than through a single representative case — a schema that gated
  // nothing passed ten route tests in E5 Task 4.
  //
  // Deleting the zod parse turns six of these ten red: the string caps, the
  // trims and the type confusion. The other four (a non-object body, a
  // missing stage, a stage outside §9.1, an unparseable date) stay green
  // because `recordProtocol` refuses them too — the stale-stage check and
  // the NaN guard. That is defence in depth, not four spare tests, and it is
  // recorded here so nobody reads all ten as proof of the schema.
  it.each([
    ["not an object", 42],
    ["missing stage", { protocolNumber: "P-1", channel: "SAC", registeredAt: REGISTERED_AT }],
    ["a stage outside §9.1", { ...validProtocol(), stage: "ouvidoria" }],
    ["an empty protocol number", { ...validProtocol(), protocolNumber: "   " }],
    ["a protocol number over the cap", { ...validProtocol(), protocolNumber: "9".repeat(61) }],
    ["an empty channel", { ...validProtocol(), channel: "" }],
    ["a channel over the cap", { ...validProtocol(), channel: "C".repeat(121) }],
    ["a date with no offset", { ...validProtocol(), registeredAt: "2026-08-05T15:00:00" }],
    ["a date that is not a date", { ...validProtocol(), registeredAt: "ontem" }],
    ["a protocol number that is not a string", { ...validProtocol(), protocolNumber: { toString: "x" } }],
  ])("refuses %s", async (_label, body) => {
    signedIn();
    const response = await protocolPOST(request(aliceCaseId, "protocol", body), ctxFor(aliceCaseId));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    expect(await protocolsOf(aliceCaseId)).toEqual([]);
  });

  it("refuses a body that is not JSON at all", async () => {
    signedIn();
    const bad = new Request(`http://localhost/api/cases/${aliceCaseId}/protocol`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    const response = await protocolPOST(bad, ctxFor(aliceCaseId));
    expect(response.status).toBe(404);
  });

  it("refuses a registeredAt in the future", async () => {
    signedIn();
    const response = await protocolPOST(
      request(aliceCaseId, "protocol", validProtocol({
        registeredAt: new Date(Date.now() + 86_400_000).toISOString(),
      })),
      ctxFor(aliceCaseId),
    );
    expect(response.status).toBe(404);
    expect(await protocolsOf(aliceCaseId)).toEqual([]);
  });
});

describe("POST /api/cases/[id]/advance", () => {
  async function withProtocol(caseId: string) {
    signedIn();
    await protocolPOST(request(caseId, "protocol", validProtocol()), ctxFor(caseId));
  }

  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await advancePOST(
      request(aliceCaseId, "advance", { reason: "user_request" }), ctxFor(aliceCaseId),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(FORBIDDEN_BODY);
  });

  it("records a response and clears the wait", async () => {
    await withProtocol(aliceCaseId);
    const response = await advancePOST(
      request(aliceCaseId, "advance", { reason: "response_received", responseSummary: "Negaram o estorno." }),
      ctxFor(aliceCaseId),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stage: "sac", nextDeadlineAt: null });

    const [protocol] = await protocolsOf(aliceCaseId);
    expect(protocol?.responseReceivedAt).toBeInstanceOf(Date);
    expect(protocol?.responseSummary).toBe("Negaram o estorno.");
    expect(await eventsOf(aliceCaseId, "response_received")).toHaveLength(1);
  });

  it("escalates on user_request and reports where the case ended up", async () => {
    await withProtocol(aliceCaseId);
    const response = await advancePOST(
      request(aliceCaseId, "advance", { reason: "user_request" }), ctxFor(aliceCaseId),
    );
    const body = await response.json() as { stage: string; nextDeadlineAt: string | null };
    expect(body.stage).toBe("consumidor_gov");
    expect(body.nextDeadlineAt).toEqual(expect.any(String));
    expect((await caseRow(aliceCaseId))?.stage).toBe("consumidor_gov");
  });

  // The claim RF-182 is allowed to put on a document has to be earned by a
  // deadline actually expiring. A person escalating early has not earned it.
  it("writes no deadline_expired event for an escalation the person asked for", async () => {
    await withProtocol(aliceCaseId);
    await advancePOST(request(aliceCaseId, "advance", { reason: "user_request" }), ctxFor(aliceCaseId));
    expect(await eventsOf(aliceCaseId, "deadline_expired")).toEqual([]);
  });

  it("returns not_found for response_received on a stage with no open protocol", async () => {
    signedIn();
    const response = await advancePOST(
      request(aliceCaseId, "advance", { reason: "response_received" }), ctxFor(aliceCaseId),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  it("answers a foreign case exactly as it answers one that never existed", async () => {
    signedIn();
    const bobCaseId = await seedCaseFor(bob);
    const foreign = await advancePOST(
      request(bobCaseId, "advance", { reason: "user_request" }), ctxFor(bobCaseId),
    );
    const missing = await advancePOST(
      request("cas_nope", "advance", { reason: "user_request" }), ctxFor("cas_nope"),
    );
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
    expect((await caseRow(bobCaseId))?.stage).toBe("draft");
  });

  // Every one of these runs against a case that ALREADY has an open
  // protocol, so a `response_received` body would otherwise succeed and the
  // only thing that can produce the 404 is the schema. Written the obvious
  // way first — against the bare fixture case — these two summary cases
  // passed with the schema deleted, because the 404 was coming from "this
  // stage has no open protocol" and had nothing to do with the body.
  it.each([
    ["not an object", "user_request"],
    ["an unknown reason", { reason: "porque_sim" }],
    ["a missing reason", { responseSummary: "algo" }],
    ["a summary over the cap", { reason: "response_received", responseSummary: "x".repeat(2_001) }],
    ["an empty summary", { reason: "response_received", responseSummary: "  " }],
    // The summary has nowhere to go on a `user_request`: `advanceCase` only
    // fills a protocol on `response_received`, so accepting it would
    // silently drop what the person wrote.
    ["a summary on a user_request", { reason: "user_request", responseSummary: "algo" }],
  ])("refuses %s", async (_label, body) => {
    await withProtocol(aliceCaseId);
    const response = await advancePOST(request(aliceCaseId, "advance", body), ctxFor(aliceCaseId));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    // Nothing was written: the protocol is still open and no response was
    // recorded against it.
    const [protocol] = await protocolsOf(aliceCaseId);
    expect(protocol?.responseReceivedAt).toBeNull();
    expect(protocol?.responseSummary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RF-182, end to end over HTTP: the two routes produce exactly the rows the
// document generator reads, and the sentence it produces names all four
// facts. The `deadline_expired` row is written by E5 Task 3's sweeper, which
// has not landed — so it is inserted here directly, in the shape
// `collectExpiredDeadlines` documents.
// ---------------------------------------------------------------------------
describe("RF-182 · what the routes leave behind is what the document cites", () => {
  it("produces a sentence naming the channel, the protocol and both dates", async () => {
    signedIn();
    await protocolPOST(request(aliceCaseId, "protocol", validProtocol()), ctxFor(aliceCaseId));
    const [protocol] = await protocolsOf(aliceCaseId);

    await ctx.db.insert(events).values({
      id: newId("evt"), userId: alice, caseId: aliceCaseId,
      type: "deadline_expired", payload: { stage: "sac" },
      occurredAt: new Date("2026-08-14T09:00:00.000Z"),
    });
    await advancePOST(request(aliceCaseId, "advance", { reason: "user_request" }), ctxFor(aliceCaseId));

    const { collectExpiredDeadlines, expiredDeadlineSentence } = await import("@pentefino/core");
    const timeline = await ctx.db.select().from(events).where(eq(events.caseId, aliceCaseId));
    const expired = collectExpiredDeadlines({
      protocols: [{
        stage: protocol!.stage,
        protocolNumber: protocol!.protocolNumber,
        channel: protocol!.channel,
        registeredAt: protocol!.registeredAt,
        responseDueAt: protocol!.responseDueAt,
      }],
      events: timeline.map((row) => ({ type: row.type, occurredAt: row.occurredAt, payload: row.payload })),
    });

    expect(expired).toHaveLength(1);
    const sentence = expiredDeadlineSentence(expired[0]!);
    expect(sentence).toContain("2026080512345");
    expect(sentence).toContain("SAC da operadora");
    expect(sentence).toContain("05/08/2026");
    expect(sentence).toContain("12/08/2026");
  });
});
