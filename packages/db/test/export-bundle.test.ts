import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, TELECOM_PLAYBOOK_V1, type ContestDocument } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  caseDocuments, caseProtocols, cases, entitlements, events, findings, invoiceItems, invoices, issuers, rules, users,
} from "../src/schema.js";
import { withUser } from "../src/with-user.js";

// ---------------------------------------------------------------------------
// RF-242 (Task 4, E8) — the complete export. The one thing this file exists
// to prove twice over: the bundle carries everything one account owns
// (`account`, `invoices`, `invoiceItems`, `findings`, `cases`,
// `caseDocuments`, `caseProtocols`, `entitlements`, `events`), and never a
// single row of anyone else's — checked on the *serialised* bundle, not just
// on array lengths, since a stray id nested inside another row's payload is
// exactly what a length check would miss.
// ---------------------------------------------------------------------------

let ctx: TestDb;
const alice = newId("usr");
const bob = newId("usr");
let issuerId: string;
let ruleId: string;

// Long enough to satisfy ContestDocument's own `body` floor; content itself
// is not under test here.
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

/**
 * One full "account's worth" of rows across every table `exportBundle` must
 * reach: an invoice with a file, an item, a finding, a case built from that
 * finding (which also writes `case_created`), a case document, a protocol
 * (which also writes `protocol_entered`, and moves the case to `sac`), and
 * an entitlement. Returns every id a test needs to assert on.
 */
async function seedFullAccount(userId: string) {
  const invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, userId, issuerId, contentHash: `hash-${invoiceId}`, source: "pdf_text", status: "analyzed",
    fileKey: `uploads/${userId}/${invoiceId}.pdf`,
  });
  const itemId = newId("itm");
  await ctx.db.insert(invoiceItems).values({
    id: itemId, invoiceId, lineNo: 1, itemKey: "k1", description: "Item de teste", normalizedDesc: "item de teste",
    amountCents: 100,
  });
  const findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId, itemId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 100,
  });

  const scoped = withUser({ userId }, ctx.db);
  const caseId = (await scoped.createCase({ invoiceId, findingIds: [findingId] }))!;
  const docId = (await scoped.createCaseDocument({
    caseId, stage: "draft", kind: "sac_script", promptVersion: 1, body: SAMPLE_BODY,
  }))!;
  await scoped.recordProtocol(caseId, {
    stage: "sac", protocolNumber: `prt-${userId}`, channel: "SAC da operadora", registeredAt: new Date(),
  });
  const entitlementId = newId("ent");
  await ctx.db.insert(entitlements).values({ id: entitlementId, userId, plan: "premium", source: "manual" });

  return { invoiceId, itemId, findingId, caseId, docId, entitlementId };
}

beforeEach(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values([
    { id: alice, email: "alice@example.com" },
    { id: bob, email: "bob@example.com" },
  ]);
  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({
    id: issuerId, slug: issuerId, category: "telecom", displayName: "Test Issuer", playbook: TELECOM_PLAYBOOK_V1,
  });
  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5,
    author: "system", reason: "test fixture",
  });
});
afterEach(async () => { await ctx.close(); });

describe("exportBundle (RF-242, INV-008)", () => {
  it("returns null for an anonymous session — §8.2 puts this under /api/me, and there is no \"me\" without an account", async () => {
    const scoped = withUser({ sessionId: "ses_anonymous000000000" }, ctx.db);
    expect(await scoped.exportBundle()).toBeNull();
  });

  it("returns empty arrays, not an error, for an account with no invoices or cases yet", async () => {
    const bundle = await withUser({ userId: alice }, ctx.db).exportBundle();
    expect(bundle).toEqual({
      formatVersion: 1,
      account: expect.objectContaining({ id: alice, email: "alice@example.com" }),
      invoices: [],
      invoiceItems: [],
      findings: [],
      cases: [],
      caseDocuments: [],
      caseProtocols: [],
      entitlements: [],
      events: [],
    });
  });

  it("contains this user's own invoice, item, finding, case, document, protocol and event", async () => {
    const seeded = await seedFullAccount(alice);
    const bundle = await withUser({ userId: alice }, ctx.db).exportBundle();

    expect(bundle).not.toBeNull();
    expect(bundle!.formatVersion).toBe(1);
    expect(bundle!.account).toMatchObject({ id: alice, email: "alice@example.com" });
    expect(bundle!.invoices.map((r) => r.id)).toContain(seeded.invoiceId);
    expect(bundle!.invoiceItems.map((r) => r.id)).toContain(seeded.itemId);
    expect(bundle!.findings.map((r) => r.id)).toContain(seeded.findingId);
    expect(bundle!.cases.map((r) => r.id)).toContain(seeded.caseId);
    expect(bundle!.caseDocuments.map((r) => r.id)).toContain(seeded.docId);
    expect(bundle!.caseProtocols.some((r) => r.caseId === seeded.caseId)).toBe(true);
    expect(bundle!.entitlements.map((r) => r.id)).toContain(seeded.entitlementId);
    expect(bundle!.events.some((e) => e.type === "case_created" && e.caseId === seeded.caseId)).toBe(true);
    expect(bundle!.events.some((e) => e.type === "protocol_entered" && e.caseId === seeded.caseId)).toBe(true);
  });

  // --- INV-008, the load-bearing test of this file. Checked on the
  // serialised string, not on array lengths or `.map(id)` alone: a length
  // check cannot see an id smuggled into a *nested* field (an event
  // payload, a case document body), which is exactly the shape of leak an
  // ownership filter pointed at the wrong column would produce.
  it("never includes another user's rows anywhere in the serialised bundle", async () => {
    const seededBob = await seedFullAccount(bob);
    const seededAlice = await seedFullAccount(alice);

    const bundle = await withUser({ userId: alice }, ctx.db).exportBundle();
    const raw = JSON.stringify(bundle);

    // Sanity: this is not a false pass from an empty bundle.
    expect(raw).toContain(seededAlice.invoiceId);
    expect(raw).toContain(seededAlice.caseId);

    for (const leaked of [
      bob, "bob@example.com",
      seededBob.invoiceId, seededBob.itemId, seededBob.findingId,
      seededBob.caseId, seededBob.docId, seededBob.entitlementId,
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });
});
