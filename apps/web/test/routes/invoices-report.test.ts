import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { lintUserFacingText } from "@pentefino/ai";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, findings, invoiceItems, invoices, issuers, rules } = schema;

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
let ruleId: string;

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

  ruleId = newId("rul");
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

  // --- RF-125: a shadow finding earns trust silently; it must never reach
  // this response, in the list or in the totals it inflates otherwise.

  it("excludes a shadow finding from both the findings list and the totals (RF-125)", async () => {
    const shadowId = newId("fnd");
    await ctx.db.insert(findings).values({
      id: shadowId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 5000, doubledCents: 2500,
      shadow: true,
    });

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    const body = await response.json();

    expect(body.findings.map((f: { id: string }) => f.id)).not.toContain(shadowId);
    // Unchanged from the single visible finding the top-level beforeEach
    // seeds - the shadow finding's 5000/2500 must not be summed in here.
    expect(body.totals).toEqual({ suspectCents: 1500, doubledCents: 700 });
  });

  // --- RF-143: dismissing a finding must not just hide it on the client -
  // a reload (this same route, called again) must keep it gone, and the
  // totals it reads off `findingsForInvoice` must never disagree with the
  // list a person is looking at.

  it("excludes a dismissed finding from both the list and the totals, so a reload does not bring it back (RF-143)", async () => {
    const dismissedId = newId("fnd");
    await ctx.db.insert(findings).values({
      id: dismissedId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 3000, doubledCents: 1500,
      status: "dismissed_by_user",
    });

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    const body = await response.json();

    expect(body.findings.map((f: { id: string }) => f.id)).not.toContain(dismissedId);
    // Unchanged from the single visible (open) finding the top-level
    // beforeEach seeds - the dismissed finding's 3000/1500 must not be
    // summed in here, or the totals would disagree with the list.
    expect(body.totals).toEqual({ suspectCents: 1500, doubledCents: 700 });
  });

  it("keeps a confirmed finding in both the list and the totals - it is the strongest signal on the screen", async () => {
    const confirmedId = newId("fnd");
    await ctx.db.insert(findings).values({
      id: confirmedId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 2000, doubledCents: 1000,
      status: "confirmed_by_user",
    });

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    const body = await response.json();

    expect(body.findings.map((f: { id: string }) => f.id)).toContain(confirmedId);
    expect(body.totals).toEqual({ suspectCents: 1500 + 2000, doubledCents: 700 + 1000 });
  });

  // --- RF-124: the route classifies every finding by confidence into one of
  // three bands, but never picks the pt-BR wording itself (that is the UI's
  // job, per PRD §13.3).

  it("carries RF-124's confidence band per finding", async () => {
    const questionId = newId("fnd");
    const verifyId = newId("fnd");
    await ctx.db.insert(findings).values([
      { id: questionId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.5, amountCents: 100 },
      { id: verifyId, invoiceId, ruleId, ruleVersion: 1, confidence: 0.7, amountCents: 100 },
    ]);

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    const body = await response.json();
    const byId = Object.fromEntries(body.findings.map((f: { id: string }) => [f.id, f]));

    expect(byId[questionId].band).toBe("question"); // < 0.55
    expect(byId[verifyId].band).toBe("verify"); // 0.55 - 0.8
    expect(byId[findingId].band).toBe("likely"); // > 0.8 (confidence 0.9 from the top beforeEach)
  });

  // --- RF-124's other half: a `confirm`-kind rule's finding carries the
  // question the interface should ask, instead of the route asserting
  // anything about the charge itself.

  it("exposes askUser for a confirm-kind finding", async () => {
    const confirmRuleId = newId("rul");
    await ctx.db.insert(rules).values({
      id: confirmRuleId, slug: confirmRuleId, category: "telecom", kind: "confirm",
      spec: {
        kind: "confirm", question: "Você reconhece esta cobrança?", options: ["Sim", "Não"],
        onNo: "create_finding",
      },
      confidenceBase: 0.4, author: "system", reason: "fixture",
    });
    const confirmFindingId = newId("fnd");
    await ctx.db.insert(findings).values({
      id: confirmFindingId, invoiceId, ruleId: confirmRuleId, ruleVersion: 1, confidence: 0.4, amountCents: 0,
    });

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    const body = await response.json();
    const found = body.findings.find((f: { id: string }) => f.id === confirmFindingId);

    expect(found.askUser).toEqual({ question: "Você reconhece esta cobrança?", options: ["Sim", "Não"] });
    expect(found.band).toBe("question");
    // A `pattern`-kind finding (the top beforeEach's fixture) never gets one.
    expect(body.findings.find((f: { id: string }) => f.id === findingId).askUser).toBeUndefined();
  });

  // --- RF-128: 3+ findings sharing a section become one aggregate, shown
  // above the individual lines, matching the PRD's own acceptance example.

  it("puts the RF-128 cluster aggregate first and its wording passes the §14.3 lint", async () => {
    const clusterInvoiceId = newId("inv");
    await ctx.db.insert(invoices).values({
      id: clusterInvoiceId, issuerId, sessionId: sessionA, contentHash: "cluster-hash", source: "pdf_text",
      status: "analyzed",
    });

    const findingIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const itemId = newId("itm");
      await ctx.db.insert(invoiceItems).values({
        id: itemId, invoiceId: clusterInvoiceId, lineNo: i, itemKey: `sva-${i}`,
        section: "Serviços digitais", description: `SVA ${i}`, normalizedDesc: `SVA ${i}`, amountCents: 1032,
      });
      const fId = newId("fnd");
      await ctx.db.insert(findings).values({
        id: fId, invoiceId: clusterInvoiceId, itemId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 1032,
      });
      findingIds.push(fId);
    }

    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const response = await GET(
      new Request(`http://localhost/api/invoices/${clusterInvoiceId}/report`), ctxFor(clusterInvoiceId),
    );
    const body = await response.json();

    expect(body.findings).toHaveLength(6); // 1 aggregate + 5 individual lines
    expect(body.findings[0].aggregate).toBe(true);
    // PRD §10 RF-128's own acceptance text, verbatim.
    expect(body.findings[0].evidence).toEqual(["R$ 51,60 em 5 serviços digitais"]);
    expect(body.findings.slice(1).map((f: { id: string }) => f.id).sort()).toEqual(findingIds.sort());
    // The aggregate is a display-only view over the same money - it must
    // not be double-counted into the totals a user reads as "at stake".
    expect(body.totals.suspectCents).toBe(5160);

    const lint = lintUserFacingText(body.findings[0].evidence[0]);
    expect(lint.ok).toBe(true);
  });
});
