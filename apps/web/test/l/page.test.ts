import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { containsPii, newId, newPublicToken } from "@pentefino/core";
import { lintUserFacingText } from "@pentefino/ai";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, invoiceItems, invoices, issuers, findings, rules } = schema;

vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { container } = await import("../../lib/container.js");
const { default: PublicLaudoPage } = await import("../../app/l/[token]/page.js");

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
let ruleId: string;
const sessionA = "ses_owner00000000000000";

beforeEach(async () => {
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));

  await ctx.db.insert(anonymousSessions).values({ id: sessionA, expiresAt: new Date(Date.now() + 60_000) });
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
  vi.restoreAllMocks();
});

function ctxFor(token: string) {
  return { params: Promise.resolve({ token }) };
}

async function seedIssuer(displayName: string, category: "telecom" | "card" | "energy" | "water" = "telecom") {
  const id = newId("iss");
  await ctx.db.insert(issuers).values({ id, slug: id, category, displayName });
  return id;
}

async function seedAnalyzedInvoice(options: { issuerId?: string; status?: string } = {}) {
  const invoiceId = newId("inv");
  const publicToken = newPublicToken();
  await ctx.db.insert(invoices).values({
    id: invoiceId, issuerId: options.issuerId, sessionId: sessionA, contentHash: invoiceId,
    source: "pdf_text", status: options.status ?? "analyzed", publicToken,
  });
  return { invoiceId, publicToken };
}

async function seedFinding(invoiceId: string, amountCents: number, doubledCents: number | null = null, shadow = false) {
  await ctx.db.insert(findings).values({
    id: newId("fnd"), invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents, doubledCents, shadow,
    evidence: ["não deveria aparecer aqui"],
  });
}

async function renderPage(token: string): Promise<string> {
  const element = await PublicLaudoPage(ctxFor(token));
  return renderToStaticMarkup(element as React.ReactElement);
}

async function expectNotFound(token: string) {
  await expect(PublicLaudoPage(ctxFor(token))).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
}

describe("GET /l/[token] - works with no session at all (RF-146)", () => {
  it("renders the report for a valid, analyzed token, with no cookies/session touched", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 2545);

    const html = await renderPage(publicToken);
    expect(html).toContain("Encontramos R$ 25,45 para você verificar.");
    expect(html).toContain("Claro");
  });

  it("shows the upload call to action, linking to the home page", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 1000);

    const html = await renderPage(publicToken);
    expect(html).toContain("Conferir minha fatura");
    expect(html).toMatch(/href="\/"[^>]*>Conferir minha fatura/);
  });
});

describe("GET /l/[token] - addressing and revocation (RF-146 acceptance)", () => {
  it("returns 404 (Next's notFound) for a token that does not exist", async () => {
    await expectNotFound("does-not-exist");
  });

  it("returns 404 for the invoice's own id, since the id is not the page's address", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId } = await seedAnalyzedInvoice({ issuerId });
    await expectNotFound(invoiceId);
  });

  it("returns 404 once the token has been revoked (publicToken set to null)", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await ctx.db.update(invoices).set({ publicToken: null }).where(eq(invoices.id, invoiceId));
    await expectNotFound(publicToken);
  });

  it("returns 404 for a valid token whose invoice has not finished analysis yet", async () => {
    const issuerId = await seedIssuer("Claro");
    const { publicToken } = await seedAnalyzedInvoice({ issuerId, status: "extracting" });
    await expectNotFound(publicToken);
  });

  it("returns 404 for a needs_review invoice - no honest total to share yet", async () => {
    const issuerId = await seedIssuer("Claro");
    const { publicToken } = await seedAnalyzedInvoice({ issuerId, status: "needs_review" });
    await expectNotFound(publicToken);
  });
});

describe("GET /l/[token] - what 'anonymised' means here", () => {
  it("shows the doubled-amount line only when doubledCents is positive", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 1000, null);

    const html = await renderPage(publicToken);
    expect(html).not.toContain("A norma prevê devolução em dobro");
  });

  it("includes the doubled-amount line, in §14.2's exact wording, when doubledCents is positive", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 1000, 500);

    const html = await renderPage(publicToken);
    expect(html).toContain("A norma prevê devolução em dobro: R$ 5,00 no total.");
  });

  it("excludes a shadow finding from the totals and count, same as the authenticated report", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 1000, null, false);
    await seedFinding(invoiceId, 99999, null, true); // shadow - must not count

    const html = await renderPage(publicToken);
    expect(html).toContain("Encontramos R$ 10,00 para você verificar.");
    expect(html).toContain("1 cobrança para revisar");
  });

  it("shows the written clean-report message, never a blank area, when there are no findings to share", async () => {
    const { publicToken } = await seedAnalyzedInvoice({});
    const html = await renderPage(publicToken);
    expect(html).toContain("Não encontramos cobrança a mais nesta fatura");
    expect(html).toContain("Conferir minha fatura"); // CTA still shown
  });

  it("falls back to the generic tag when the invoice has no issuer assigned at all", async () => {
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({});
    await seedFinding(invoiceId, 100);

    const html = await renderPage(publicToken);
    expect(html).toContain("Fatura");
  });

  it("never renders a finding's evidence sentence - item-level text is not part of the public page", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 100);

    const html = await renderPage(publicToken);
    expect(html).not.toContain("não deveria aparecer aqui");
  });

  it("never renders an item description or section name, even for a legitimate item", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 100);
    await ctx.db.insert(invoiceItems).values({
      id: newId("itm"), invoiceId, lineNo: 0, itemKey: "k1",
      section: "Serviços de assinatura", description: "Netflix Premium mensal",
      normalizedDesc: "netflix", amountCents: 100,
    });

    const html = await renderPage(publicToken);
    expect(html).not.toContain("Serviços de assinatura");
    expect(html).not.toContain("Netflix Premium mensal");
  });

  it("never renders the period or the due date", async () => {
    const invoiceId = newId("inv");
    const publicToken = newPublicToken();
    await ctx.db.insert(invoices).values({
      id: invoiceId, sessionId: sessionA, contentHash: invoiceId, source: "pdf_text", status: "analyzed",
      publicToken, periodStart: "2026-07-01", periodEnd: "2026-07-31", dueDate: "2026-08-10",
    });
    await seedFinding(invoiceId, 100);

    const html = await renderPage(publicToken);
    for (const needle of ["2026-07-01", "2026-07-31", "2026-08-10", "01/07", "10/08"]) {
      expect(html).not.toContain(needle);
    }
  });
});

describe("GET /l/[token] - §14.3's lint, on every string the page can ever render", () => {
  it("passes lintUserFacingText for every string on the page, findings-only case", async () => {
    const issuerId = await seedIssuer("Vivo", "telecom");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 5160);

    const html = await renderPage(publicToken);
    expect(lintUserFacingText(html)).toMatchObject({ ok: true });
  });

  it("passes lintUserFacingText including the doubled-amount and CTA copy", async () => {
    const issuerId = await seedIssuer("Vivo", "telecom");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 5160, 2500);

    const html = await renderPage(publicToken);
    expect(lintUserFacingText(html)).toMatchObject({ ok: true });
  });

  it("passes lintUserFacingText for the clean-report state", async () => {
    const { publicToken } = await seedAnalyzedInvoice({});
    const html = await renderPage(publicToken);
    expect(lintUserFacingText(html)).toMatchObject({ ok: true });
  });
});

// --- INV-007's "before finishing, try to leak something" drill: an invoice
// whose item descriptions, section names AND issuer display name all carry
// a name, a CPF, a phone number and an address - the public page must
// surface none of it, in the HTML or anywhere else in the response.

describe("GET /l/[token] - the leak drill (INV-007)", () => {
  const PII_NAME = "Maria Aparecida Souza";
  const PII_CPF = "123.456.789-09"; // a real, check-digit-valid CPF fixture
  const PII_PHONE = "(11) 98765-4321";
  const PII_ADDRESS = "Rua das Palmeiras, 452";
  const POISONED_DISPLAY_NAME = `${PII_NAME} - CPF ${PII_CPF} - tel ${PII_PHONE} - ${PII_ADDRESS}`;

  async function seedPoisonedInvoice() {
    const issuerId = await seedIssuer(POISONED_DISPLAY_NAME, "telecom");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 5160, 2500);
    await ctx.db.insert(invoiceItems).values({
      id: newId("itm"), invoiceId, lineNo: 0, itemKey: "poisoned-item",
      section: `Titular: ${PII_NAME} - ${PII_ADDRESS}`,
      description: `Ligação para ${PII_PHONE}, CPF ${PII_CPF}`,
      normalizedDesc: "ligacao", amountCents: 100,
    });
    return { invoiceId, publicToken };
  }

  it("never includes the poisoned issuer name, section name or item description as substrings of the rendered HTML", async () => {
    const { publicToken } = await seedPoisonedInvoice();
    const html = await renderPage(publicToken);

    for (const secret of [PII_NAME, PII_CPF, PII_PHONE, PII_ADDRESS, POISONED_DISPLAY_NAME]) {
      expect(html).not.toContain(secret);
    }
  });

  it("falls back to the category tag instead of the poisoned display name", async () => {
    const { publicToken } = await seedPoisonedInvoice();
    const html = await renderPage(publicToken);
    expect(html).toContain("Telecom");
    expect(html).not.toContain(POISONED_DISPLAY_NAME);
  });

  it("never lets containsPii see a positive hit in the rendered HTML", async () => {
    const { publicToken } = await seedPoisonedInvoice();
    const html = await renderPage(publicToken);
    expect(containsPii(html)).toBe(false);
  });

  // This page has no client component boundary (no "use client", no
  // useState/props crossing a server/client split) and no
  // `generateMetadata` override - the only channel a browser's response
  // could carry page-specific data through, beyond the visible markup
  // asserted above, would be a React hydration payload embedded in a
  // <script> tag. Asserting there is none rules that channel out directly
  // instead of only by architectural argument.
  it("embeds no <script> tag at all - there is no hydration payload that could carry the poisoned data", async () => {
    const { publicToken } = await seedPoisonedInvoice();
    const html = await renderPage(publicToken);
    expect(html).not.toContain("<script");
  });

  // --- the honest, already-documented limit of containsPii (see
  // packages/core/src/invoice/mask.ts and card.test.ts's identical test): a
  // bare name or phone number in issuer.displayName is not caught. Recorded
  // here, for this page, rather than left to be discovered by inference.

  it("documents the residual gap: a bare phone number in issuer.displayName reaches the page verbatim", async () => {
    const issuerId = await seedIssuer(PII_PHONE, "telecom");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 100);

    expect(containsPii(PII_PHONE)).toBe(false); // the detector's own blind spot

    const html = await renderPage(publicToken);
    expect(html).toContain(PII_PHONE);
  });

  it("documents the same gap for a bare person name in issuer.displayName", async () => {
    const issuerId = await seedIssuer(PII_NAME, "telecom");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 100);

    expect(containsPii(PII_NAME)).toBe(false);

    const html = await renderPage(publicToken);
    expect(html).toContain(PII_NAME);
  });
});
