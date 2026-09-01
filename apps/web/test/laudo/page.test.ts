import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { newId } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, findings, invoices, issuers, rules } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { default: LaudoPage } = await import("../../app/laudo/[id]/page.js");

const SECRET = "laudo-page-test-secret";

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
const sessionA = "ses_owner00000000000000";
const sessionB = "ses_other00000000000000";
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
  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "x" }, confidenceBase: 0.5, author: "system", reason: "fixture",
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

function asOwner() {
  useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function renderPage(id: string): Promise<string> {
  const element = await LaudoPage(ctxFor(id));
  return renderToStaticMarkup(element);
}

async function insertInvoice(status: string, contentHash: string): Promise<string> {
  const invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({ id: invoiceId, issuerId, sessionId: sessionA, contentHash, source: "pdf_text", status });
  return invoiceId;
}

describe("/laudo/[id] - the four required states (PRD §13.2)", () => {
  it("with findings: shows the total, a confidence label in words, the evidence sentence and the dismiss button", async () => {
    const invoiceId = await insertInvoice("analyzed", "with-findings-hash");
    await ctx.db.insert(findings).values({
      id: newId("fnd"), invoiceId, ruleId, ruleVersion: 1, confidence: 0.7,
      evidence: ["Cobrada duas vezes no mesmo ciclo."], amountCents: 2545,
    });

    asOwner();
    const html = await renderPage(invoiceId);

    expect(html).toContain("Encontramos R$ 25,45 para você verificar.");
    expect(html).toContain("Verificar");
    expect(html).toContain("Cobrada duas vezes no mesmo ciclo.");
    expect(html).toContain("Isso eu contratei");
  });

  it("with findings: shows the doubled amount beside the charged one when the legal basis allows it", async () => {
    const invoiceId = await insertInvoice("analyzed", "doubled-hash");
    await ctx.db.insert(findings).values({
      id: newId("fnd"), invoiceId, ruleId, ruleVersion: 1, confidence: 0.9,
      evidence: ["ICMS sobre TUSD/TUST."], amountCents: 2545, doubledCents: 5090,
    });

    asOwner();
    const html = await renderPage(invoiceId);

    expect(html).toContain("Provável cobrança a contestar");
    expect(html).toContain("A norma prevê devolução em dobro: R$ 50,90 no total.");
    expect(html).not.toMatch(/direito a receber/);
  });

  it("without findings: renders the written empty state, never a blank area", async () => {
    const invoiceId = await insertInvoice("analyzed", "empty-hash");

    asOwner();
    const html = await renderPage(invoiceId);

    expect(html).toContain("Conferimos sua fatura e não encontramos nada para você questionar desta vez.");
    expect(html).not.toContain("Isso eu contratei");
  });

  it("needs_review: shows the honest §8.1 message and a resend CTA, and invents no partial report even though rows exist", async () => {
    const invoiceId = await insertInvoice("needs_review", "needs-review-hash");
    // A partial extraction can leave real rows behind - RF-144's whole point
    // is that this screen must never assemble them into something that
    // looks like a report.
    await ctx.db.insert(findings).values({
      id: newId("fnd"), invoiceId, ruleId, ruleVersion: 1, confidence: 0.9,
      evidence: ["Não deveria aparecer."], amountCents: 999,
    });

    asOwner();
    const html = await renderPage(invoiceId);

    expect(html).toContain("Não conseguimos ler essa fatura com segurança. Tente uma foto mais nítida.");
    expect(html).toContain("Enviar uma foto mais nítida");
    expect(html).not.toContain("Não deveria aparecer.");
    expect(html).not.toContain("R$ 9,99");
  });

  it("with pending questions: shows the question and its options as answerable, separately from confirmed findings", async () => {
    const invoiceId = await insertInvoice("analyzed", "questions-hash");
    const confirmRuleId = newId("rul");
    await ctx.db.insert(rules).values({
      id: confirmRuleId, slug: confirmRuleId, category: "telecom", kind: "confirm",
      spec: {
        kind: "confirm", question: "Você reconhece esta assinatura?", options: ["Sim", "Não"],
        onNo: "create_finding",
      },
      confidenceBase: 0.4, author: "system", reason: "fixture",
    });
    await ctx.db.insert(findings).values({
      id: newId("fnd"), invoiceId, ruleId: confirmRuleId, ruleVersion: 1, confidence: 0.4,
      evidence: ["Assinatura não reconhecida no histórico."], amountCents: 0,
    });

    asOwner();
    const html = await renderPage(invoiceId);

    expect(html).toContain("Perguntas pendentes");
    expect(html).toContain("Você reconhece esta assinatura?");
    expect(html).toContain(">Sim<");
    expect(html).toContain(">Não<");
  });
});

describe("/laudo/[id] - access control (INV-008)", () => {
  it("shows the written forbidden message with no session cookie, not a blank page", async () => {
    const invoiceId = await insertInvoice("analyzed", "forbidden-hash");
    useCookies(createCookieStore());

    const html = await renderPage(invoiceId);
    expect(html).toContain("Você não tem acesso a esse item.");
  });

  it("shows the written not_found message for another session's invoice, identical to a truly missing one", async () => {
    const invoiceId = await insertInvoice("analyzed", "other-session-hash");
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));

    const html = await renderPage(invoiceId);
    expect(html).toContain("Não encontramos esse item.");
  });
});
