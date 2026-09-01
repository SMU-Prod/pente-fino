import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { containsPii, newId, newPublicToken } from "@pentefino/core";
import { lintUserFacingText } from "@pentefino/ai";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, findings, invoiceItems, invoices, issuers, rules } = schema;

// `next/og`'s `ImageResponse` is mocked in every test in *this* file: what
// these tests care about is the React element tree and headers the route
// hands to it - "the payload", per this task's brief - not the rendered
// PNG. A real rasterised image is exercised separately in card.visual.test.ts,
// which does not mock this module. Splitting the two is what lets this file
// capture the exact tree without ever having to decode a PNG back into text.
let capturedTree: unknown;
let capturedOptions: unknown;
vi.mock("next/og", () => ({ ImageResponse: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { container } = await import("../../lib/container.js");
const { ImageResponse } = await import("next/og");
const { GET } = await import("../../app/api/card/[token]/route.js");

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
let ruleId: string;
const sessionA = "ses_owner00000000000000";

beforeEach(async () => {
  capturedTree = undefined;
  capturedOptions = undefined;
  // Re-armed every test, not just once at module load: `afterEach`'s
  // `vi.restoreAllMocks()` below strips a mock's implementation after the
  // test that set it up finishes (the same reason findings-feedback.test.ts
  // and invoices-report.test.ts re-call their own `useCookies`/`container`
  // setup in every `beforeEach` rather than once at the top of the file).
  vi.mocked(ImageResponse).mockImplementation((tree: unknown, options: unknown) => {
    capturedTree = tree;
    capturedOptions = options;
    return new Response("mock-png-bytes", { status: 200, headers: { "content-type": "image/png" } }) as never;
  });
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

function request(token: string): Request {
  return new Request(`http://localhost/api/card/${token}`);
}

/** Recursively collects every string a React element tree's children hold. */
function collectText(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (node && typeof node === "object" && "props" in node) {
    return collectText((node as { props?: { children?: unknown } }).props?.children);
  }
  return [];
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
  });
}

describe("GET /api/card/[token]", () => {
  // --- addressing: an invoice id alone is not a card address ------------

  it("returns not_found for a token that does not exist", async () => {
    const response = await GET(request("does-not-exist"), ctxFor("does-not-exist"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "Não encontramos esse item." } });
  });

  it("returns not_found for the invoice's own id, since the id is not the card's address", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId } = await seedAnalyzedInvoice({ issuerId });
    const response = await GET(request(invoiceId), ctxFor(invoiceId));
    expect(response.status).toBe(404);
  });

  it("returns not_found once the token has been revoked (publicToken set to null)", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await ctx.db.update(invoices).set({ publicToken: null }).where(eq(invoices.id, invoiceId));

    const response = await GET(request(publicToken), ctxFor(publicToken));
    expect(response.status).toBe(404);
  });

  it("returns not_found for a valid token whose invoice has not finished analysis yet", async () => {
    const issuerId = await seedIssuer("Claro");
    const { publicToken } = await seedAnalyzedInvoice({ issuerId, status: "extracting" });

    const response = await GET(request(publicToken), ctxFor(publicToken));
    expect(response.status).toBe(404);
  });

  // --- the successful path -----------------------------------------------

  it("renders a 1200x630 image for a valid token", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 5160, 2500);

    const response = await GET(request(publicToken), ctxFor(publicToken));
    expect(response.status).toBe(200);
    expect(capturedOptions).toMatchObject({ width: 1200, height: 630 });
  });

  it("shows the doubled-amount line only when doubledCents is positive", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 1000, null);

    await GET(request(publicToken), ctxFor(publicToken));
    expect(collectText(capturedTree)).not.toContain("A norma prevê devolução em dobro");
  });

  it("includes the doubled-amount line, in §14.2's exact wording, when doubledCents is positive", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 1000, 500);

    await GET(request(publicToken), ctxFor(publicToken));
    expect(collectText(capturedTree)).toContain("A norma prevê devolução em dobro");
  });

  it("excludes a shadow finding from the card's totals, same as the authenticated report", async () => {
    const issuerId = await seedIssuer("Claro");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 1000, null, false);
    await seedFinding(invoiceId, 99999, null, true); // shadow - must not count

    await GET(request(publicToken), ctxFor(publicToken));
    expect(collectText(capturedTree)).toContain("Encontramos R$ 10,00 para você verificar");
  });

  it("uses a category tag when the invoice has no issuer assigned", async () => {
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({});
    await seedFinding(invoiceId, 100);

    await GET(request(publicToken), ctxFor(publicToken));
    expect(collectText(capturedTree)).toContain("Fatura");
  });

  // --- §14.3's lint, on every string the card can ever render -------------

  it("passes lintUserFacingText for every string on the card, findings-only case", async () => {
    const issuerId = await seedIssuer("Vivo", "telecom");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 5160);

    await GET(request(publicToken), ctxFor(publicToken));
    for (const text of collectText(capturedTree)) {
      expect(lintUserFacingText(text), `offending string: ${JSON.stringify(text)}`).toMatchObject({ ok: true });
    }
  });

  it("passes lintUserFacingText for every string on the card, including the doubled-amount line", async () => {
    const issuerId = await seedIssuer("Vivo", "telecom");
    const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
    await seedFinding(invoiceId, 5160, 2500);

    await GET(request(publicToken), ctxFor(publicToken));
    for (const text of collectText(capturedTree)) {
      expect(lintUserFacingText(text), `offending string: ${JSON.stringify(text)}`).toMatchObject({ ok: true });
    }
  });

  // --- RF-145's second acceptance test: absence of PII in the card's
  // payload - the React element tree and headers `ImageResponse` is built
  // from, not merely what a viewer would see rendered. See the route's own
  // `loadCardData`/`safeIssuerLabel` doc comments for the reasoning this
  // test exercises.

  describe("PII absence in the card's payload (RF-145)", () => {
    const PII_NAME = "Maria Aparecida Souza";
    const PII_CPF = "123.456.789-09"; // same fixture value packages/core's mask tests use - a real, valid CPF
    const PII_PHONE = "(11) 98765-4321";
    const PII_ADDRESS = "Rua das Palmeiras, 452";
    const POISONED_DISPLAY_NAME =
      `${PII_NAME} - CPF ${PII_CPF} - tel ${PII_PHONE} - ${PII_ADDRESS}`;

    async function seedPoisonedInvoice() {
      const issuerId = await seedIssuer(POISONED_DISPLAY_NAME, "telecom");
      const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
      await seedFinding(invoiceId, 5160, 2500);
      // Section names and item descriptions are stuffed with the same PII,
      // on the same invoice the card is generated for - loadCardData must
      // never touch invoiceItems at all for this to matter.
      await ctx.db.insert(invoiceItems).values({
        id: newId("itm"), invoiceId, lineNo: 0, itemKey: "poisoned-item",
        section: `Titular: ${PII_NAME} - ${PII_ADDRESS}`,
        description: `Ligação para ${PII_PHONE}, CPF ${PII_CPF}`,
        normalizedDesc: "ligacao", amountCents: 100,
      });
      return { invoiceId, publicToken };
    }

    it("never includes the poisoned issuer name, section name or item description as substrings of the payload", async () => {
      const { publicToken } = await seedPoisonedInvoice();
      const response = await GET(request(publicToken), ctxFor(publicToken));
      expect(response.status).toBe(200);

      const serializedTree = JSON.stringify(capturedTree);
      // `.forEach` rather than the spread/`.entries()` iterator protocol:
      // stably typed across both the DOM and Node `Headers` declarations
      // this monorepo's various tsconfigs can resolve to, where the
      // iterator surface is not always visible to the type checker.
      const headerPairs: string[] = [];
      response.headers.forEach((value, key) => headerPairs.push(`${key}: ${value}`));
      const serializedHeaders = JSON.stringify(headerPairs);
      const serializedOptions = JSON.stringify(capturedOptions);

      for (const secret of [PII_NAME, PII_CPF, PII_PHONE, PII_ADDRESS, POISONED_DISPLAY_NAME]) {
        expect(serializedTree).not.toContain(secret);
        expect(serializedHeaders).not.toContain(secret);
        expect(serializedOptions).not.toContain(secret);
      }
    });

    it("never lets containsPii see a positive hit in the serialized tree", async () => {
      const { publicToken } = await seedPoisonedInvoice();
      await GET(request(publicToken), ctxFor(publicToken));
      expect(containsPii(JSON.stringify(capturedTree))).toBe(false);
    });

    it("falls back to the category tag instead of the poisoned display name, since it contains a valid CPF and an address", async () => {
      const { publicToken } = await seedPoisonedInvoice();
      await GET(request(publicToken), ctxFor(publicToken));
      const strings = collectText(capturedTree);
      expect(strings).toContain("Telecom");
      expect(strings).not.toContain(POISONED_DISPLAY_NAME);
    });

    // --- the honest limit of this defense: containsPii does not detect a
    // name or a phone number on its own (packages/core/src/invoice/mask.ts's
    // own documented E0 limitation). This is not a false negative in the
    // route's logic; it is a gap in the one detector this task's brief asks
    // to reuse rather than reimplement. Recorded here so the gap is visible
    // in the suite instead of only in a comment - see safeIssuerLabel's doc
    // comment in route.tsx for what actually closes it in production
    // (issuers.displayName's closed provenance, not this check).

    it("documents a residual gap: a bare phone number in issuer.displayName is not caught by containsPii and reaches the card verbatim", async () => {
      const issuerId = await seedIssuer(PII_PHONE, "telecom");
      const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
      await seedFinding(invoiceId, 100);

      expect(containsPii(PII_PHONE)).toBe(false); // the detector's own blind spot

      await GET(request(publicToken), ctxFor(publicToken));
      // Not the outcome anyone wants - recorded so a reader sees the exact
      // shape of the residual risk instead of inferring it from a comment.
      expect(collectText(capturedTree)).toContain(PII_PHONE);
    });

    it("documents the same gap for a bare person name in issuer.displayName", async () => {
      const issuerId = await seedIssuer(PII_NAME, "telecom");
      const { invoiceId, publicToken } = await seedAnalyzedInvoice({ issuerId });
      await seedFinding(invoiceId, 100);

      expect(containsPii(PII_NAME)).toBe(false);

      await GET(request(publicToken), ctxFor(publicToken));
      expect(collectText(capturedTree)).toContain(PII_NAME);
    });
  });
});

describe("the card's cache policy does not outlive its token", () => {
  // `next/og` is mocked in this file, so the real Response never exists here —
  // assert on the options the route hands it, the same way the payload tests
  // do. Asserting on `response.headers` would pass vacuously: the mock returns
  // a Response with no cache header at all, so "does not contain immutable"
  // is trivially true whether or not the route sets anything.
  it("does not accept next/og's one-year immutable default", async () => {
    const { publicToken } = await seedAnalyzedInvoice();
    await GET(request(publicToken), ctxFor(publicToken));

    const cacheControl = (capturedOptions as { headers?: Record<string, string> })
      ?.headers?.["Cache-Control"];
    expect(cacheControl).toBeTypeOf("string");
    expect(cacheControl).not.toMatch(/immutable/);
    expect(cacheControl).not.toMatch(/max-age=31536000/);
  });

  it("bounds how long a revoked card can still be served", async () => {
    const { publicToken } = await seedAnalyzedInvoice();
    await GET(request(publicToken), ctxFor(publicToken));

    const cacheControl = (capturedOptions as { headers?: Record<string, string> })
      ?.headers?.["Cache-Control"] ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);

    // RF-146 makes the token revocable. A cache lifetime measured in hours
    // would mean revocation takes effect everywhere except where the image
    // actually went.
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
  });
});
