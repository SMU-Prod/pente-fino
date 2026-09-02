import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId, type ContestDocument } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { anonymousSessions, caseDocuments, cases, invoices, issuers, users } from "../src/schema.js";
import { resolveSession, withUser } from "../src/with-user.js";

let ctx: TestDb;
const alice = newId("usr");
const bob = newId("usr");
let aliceCaseId: string;
let bobCaseId: string;

// A realistic-shaped ContestDocument: long enough to satisfy `body`'s
// 200-character floor, short enough to stay readable in a diff.
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

async function seedCase(db: TestDb["db"], userId: string): Promise<string> {
  const issuerId = newId("iss");
  await db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Test Issuer" });
  const invoiceId = newId("inv");
  await db.insert(invoices).values({
    id: invoiceId, userId, issuerId, contentHash: `hash-${invoiceId}`, source: "pdf_text", status: "analyzed",
  });
  const caseId = newId("cas");
  await db.insert(cases).values({ id: caseId, userId, invoiceId, issuerId, findingIds: [] });
  return caseId;
}

beforeEach(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values([
    { id: alice, email: "alice@example.com" },
    { id: bob, email: "bob@example.com" },
  ]);
  aliceCaseId = await seedCase(ctx.db, alice);
  bobCaseId = await seedCase(ctx.db, bob);
});
afterEach(async () => { await ctx.close(); });

describe("createCaseDocument (RF-164's persistence half, INV-008)", () => {
  it("persists a document for a case the caller owns, unedited by construction", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });
    expect(docId).toEqual(expect.any(String));

    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId!));
    expect(row).toMatchObject({ caseId: aliceCaseId, userEdited: false, editedBody: null });
    expect(row?.body).toEqual(SAMPLE_BODY);
  });

  it("refuses to create a document for a case the caller does not own", async () => {
    const scoped = withUser({ userId: bob }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });
    expect(docId).toBeNull();

    const rows = await ctx.db.select().from(caseDocuments);
    expect(rows).toHaveLength(0);
  });

  it("refuses to create a document for an anonymous session - a case can never belong to one", async () => {
    const sessionId = newId("ses");
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });
    const scoped = withUser({ sessionId }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });
    expect(docId).toBeNull();
  });
});

describe("caseDocument (read half, INV-008)", () => {
  it("returns the document, both fields readable, to its owner", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });

    const doc = await scoped.caseDocument(docId!);
    expect(doc).toMatchObject({ id: docId, caseId: aliceCaseId, userEdited: false, editedBody: null });
    expect(doc?.body).toEqual(SAMPLE_BODY);
  });

  it("does not return another user's document", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });

    const other = withUser({ userId: bob }, ctx.db);
    expect(await other.caseDocument(docId!)).toBeNull();
  });

  it("returns null for an anonymous session, whatever the docId", async () => {
    const sessionId = newId("ses");
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });
    const scoped = withUser({ sessionId }, ctx.db);
    expect(await scoped.caseDocument(newId("doc"))).toBeNull();
  });
});

describe("editCaseDocument (RF-164's edit, INV-003 at the data layer, INV-008)", () => {
  it("sets userEdited and editedBody while leaving the generated body untouched", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });
    const edited: ContestDocument = {
      ...SAMPLE_BODY,
      body: "Texto reescrito com as próprias palavras da pessoa que está enviando esta contestação para a empresa.",
    };

    const updated = await scoped.editCaseDocument(aliceCaseId, docId!, edited);
    expect(updated?.userEdited).toBe(true);
    expect(updated?.editedBody).toEqual(edited);
    expect(updated?.body).toEqual(SAMPLE_BODY); // the original, still there

    // Both versions consultable straight from the table, not just through
    // the method that just wrote them (RF-164's "as duas versões consultáveis").
    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId!));
    expect(row?.userEdited).toBe(true);
    expect(row?.body).toEqual(SAMPLE_BODY);
    expect(row?.editedBody).toEqual(edited);
  });

  it("is idempotent to call twice - the second edit still keeps the original body", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });
    const firstEdit: ContestDocument = { ...SAMPLE_BODY, subject: "Primeira edição" };
    const secondEdit: ContestDocument = { ...SAMPLE_BODY, subject: "Segunda edição" };

    await scoped.editCaseDocument(aliceCaseId, docId!, firstEdit);
    const updated = await scoped.editCaseDocument(aliceCaseId, docId!, secondEdit);

    expect(updated?.editedBody).toEqual(secondEdit);
    expect(updated?.body).toEqual(SAMPLE_BODY);
  });

  it("returns null for another user's document, the same as for a document that does not exist", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });

    const other = withUser({ userId: bob }, ctx.db);
    expect(await other.editCaseDocument(aliceCaseId, docId!, SAMPLE_BODY)).toBeNull();
    expect(await scoped.editCaseDocument(aliceCaseId, newId("doc"), SAMPLE_BODY)).toBeNull();

    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId!));
    expect(row?.userEdited).toBe(false); // untouched by both rejected attempts
  });

  it("returns null when the docId is real but belongs to a different case than the one named", async () => {
    const scoped = withUser({ userId: alice }, ctx.db);
    const docId = await scoped.createCaseDocument({
      caseId: aliceCaseId, stage: "sac", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
    });
    const secondCaseId = await seedCase(ctx.db, alice); // same owner, different case

    expect(await scoped.editCaseDocument(secondCaseId, docId!, SAMPLE_BODY)).toBeNull();
    const [row] = await ctx.db.select().from(caseDocuments).where(eq(caseDocuments.id, docId!));
    expect(row?.userEdited).toBe(false);
  });

  it("does not let an anonymous session edit anything, whatever the ids", async () => {
    const sessionId = newId("ses");
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });
    const scoped = withUser({ sessionId }, ctx.db);
    expect(await scoped.editCaseDocument(aliceCaseId, newId("doc"), SAMPLE_BODY)).toBeNull();
  });
});

describe("resolveSession (cases.userId is NOT NULL - an anonymous session must resolve before it can own one)", () => {
  it("resolves a claimed anonymous session to its userId", async () => {
    const sessionId = newId("ses");
    await ctx.db.insert(anonymousSessions).values({
      id: sessionId, claimedByUserId: alice, expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await resolveSession(sessionId, ctx.db)).toEqual({ userId: alice });
  });

  it("leaves an unclaimed anonymous session as a bare sessionId", async () => {
    const sessionId = newId("ses");
    await ctx.db.insert(anonymousSessions).values({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) });
    expect(await resolveSession(sessionId, ctx.db)).toEqual({ sessionId });
  });

  it("leaves a session id with no anonymous_sessions row at all as a bare sessionId, rather than throwing", async () => {
    const sessionId = newId("ses");
    expect(await resolveSession(sessionId, ctx.db)).toEqual({ sessionId });
  });
});
