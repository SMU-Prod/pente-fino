import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { newId, type ContestDocument } from "@pentefino/core";
import { withUser } from "@pentefino/db";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, caseDocuments, cases, invoices, issuers, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { POST } = await import("../../app/api/cases/[id]/documents/[docId]/edit/route.js");

const SECRET = "cases-documents-edit-test-secret";

const BODY_TEXT =
  "Solicito a revisão da cobrança referente ao item que aparece em duplicidade na fatura deste período. " +
  "Peço a confirmação do valor correto e o registro do protocolo deste atendimento para acompanhamento.";

const SAMPLE_BODY: ContestDocument = {
  subject: "Cobrança em duplicidade na fatura",
  body: BODY_TEXT,
  requests: ["Revisar o valor cobrado", "Confirmar o protocolo do atendimento"],
  legalRefs: [{ law: "CDC", article: "Art. 42" }],
  scriptForCall: ["Pedir o número de protocolo do atendimento", "Pedir a gravação da ligação"],
  attachmentsChecklist: ["Fatura do período contestado"],
};

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

const alice = newId("usr");
const bob = newId("usr");
const sessionA = "ses_owner00000000000000"; // claimed by alice
const sessionB = "ses_other00000000000000"; // claimed by bob
const sessionAnon = "ses_anon0000000000000000"; // never claimed

let aliceCaseId: string;
let docId: string;

async function seedCase(db: TestDb["db"], userId: string): Promise<string> {
  const issuerId = newId("iss");
  await db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  const invoiceId = newId("inv");
  await db.insert(invoices).values({
    id: invoiceId, userId, issuerId, contentHash: `hash-${invoiceId}`, source: "pdf_text", status: "analyzed",
  });
  const caseId = newId("cas");
  await db.insert(cases).values({ id: caseId, userId, invoiceId, issuerId, findingIds: [] });
  return caseId;
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
    { id: sessionA, claimedByUserId: alice, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionB, claimedByUserId: bob, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionAnon, expiresAt: new Date(Date.now() + 60_000) },
  ]);

  aliceCaseId = await seedCase(ctx.db, alice);
  const scoped = withUser({ userId: alice }, ctx.db);
  docId = (await scoped.createCaseDocument({
    caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
  }))!;
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

function ctxFor(caseId: string, docParamId: string) {
  return { params: Promise.resolve({ id: caseId, docId: docParamId }) };
}

function request(caseId: string, docParamId: string, body: unknown): Request {
  return new Request(`http://localhost/api/cases/${caseId}/documents/${docParamId}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/cases/[id]/documents/[docId]/edit", () => {
  it("returns forbidden with no session cookie", async () => {
    useCookies(createCookieStore());
    const response = await POST(request(aliceCaseId, docId, { body: SAMPLE_BODY }), ctxFor(aliceCaseId, docId));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Você não tem acesso a esse item." },
    });
  });

  it("edits the caller's own document, keeps the original body, and returns { ok: true }", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const edited: ContestDocument = { ...SAMPLE_BODY, subject: "Cobrança em duplicidade - texto revisado por mim" };

    const response = await POST(request(aliceCaseId, docId, { body: edited }), ctxFor(aliceCaseId, docId));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId));
    expect(row?.userEdited).toBe(true);
    expect(row?.editedBody).toEqual(edited);
    expect(row?.body).toEqual(SAMPLE_BODY); // RF-164: the original stays, unedited

    const events = await withUser({ userId: alice }, ctx.db).events();
    const recorded = events.find((e) => e.type === "contest_edited");
    expect(recorded).toBeTruthy();
    expect(recorded?.caseId).toBe(aliceCaseId);
  });

  // --- INV-008: the property this task's brief specifically calls out - a
  // session must not be able to read or edit another user's document, and
  // must not learn from the error shape whether a document id exists.

  it("does not let a different user edit another user's document (INV-008)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const response = await POST(request(aliceCaseId, docId, { body: SAMPLE_BODY }), ctxFor(aliceCaseId, docId));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Não encontramos esse item." },
    });

    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId));
    expect(row?.userEdited).toBe(false); // untouched by the rejected attempt
  });

  it("returns the same not_found for someone else's document as for one that does not exist, so existence is never leaked", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const otherResponse = await POST(request(aliceCaseId, docId, { body: SAMPLE_BODY }), ctxFor(aliceCaseId, docId));
    const missingId = newId("doc");
    const missingResponse = await POST(
      request(aliceCaseId, missingId, { body: SAMPLE_BODY }),
      ctxFor(aliceCaseId, missingId),
    );

    expect(otherResponse.status).toBe(missingResponse.status);
    expect(await otherResponse.json()).toEqual(await missingResponse.json());
  });

  // --- cases.userId is NOT NULL: an anonymous session can never own a
  // case, so it can never edit a document either - the same not_found, not
  // a different error, since a bare unclaimed session and one that owns a
  // different case both simply do not own this one.

  it("treats a valid but unclaimed anonymous session as not_found, not forbidden", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionAnon, SECRET) }));
    const response = await POST(request(aliceCaseId, docId, { body: SAMPLE_BODY }), ctxFor(aliceCaseId, docId));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Não encontramos esse item." },
    });
  });

  it("returns not_found when the docId belongs to a different case than the one in the URL", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const otherCaseId = await seedCase(ctx.db, alice); // same owner, different case

    const response = await POST(request(otherCaseId, docId, { body: SAMPLE_BODY }), ctxFor(otherCaseId, docId));
    expect(response.status).toBe(404);

    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId));
    expect(row?.userEdited).toBe(false);
  });

  it("rejects malformed JSON the same way, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const malformed = new Request(`http://localhost/api/cases/${aliceCaseId}/documents/${docId}/edit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    const response = await POST(malformed, ctxFor(aliceCaseId, docId));
    expect(response.status).toBe(404);
  });

  it("rejects a body that does not satisfy ContestDocument's schema the same way, never as a 500", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const { requests: _requests, ...withoutRequests } = SAMPLE_BODY;
    const response = await POST(
      request(aliceCaseId, docId, { body: withoutRequests }),
      ctxFor(aliceCaseId, docId),
    );
    expect(response.status).toBe(404);

    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId));
    expect(row?.userEdited).toBe(false);
  });

  // --- The real product question this task's brief asks for a decision on:
  // an edit is the person's own words, not the product's claim, so the
  // §14.3 vocabulary lint (RF-162) - which exists to stop the *product*
  // asserting things - does not run against it. This is what proves that
  // choice: an edit containing "advogado" is accepted and persisted
  // verbatim, not rejected the way a *generated* document containing it
  // would be.

  it("accepts an edit containing §14.3's forbidden vocabulary - it is the person's own words, not the product's", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const edited: ContestDocument = {
      ...SAMPLE_BODY,
      body: `${BODY_TEXT} Já conversei com um advogado sobre esse caso e vou continuar acompanhando.`,
    };

    const response = await POST(request(aliceCaseId, docId, { body: edited }), ctxFor(aliceCaseId, docId));

    expect(response.status).toBe(200);
    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId));
    expect(row?.editedBody?.body).toContain("advogado");
  });
});
