import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { newId, serializeSeoContent, type SeoPageContent } from "@pentefino/core";
import { lintUserFacingText } from "@pentefino/ai";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTestContainer } from "../helpers/container.js";
import * as copy from "../../app/cobranca/[issuer]/[charge]/copy.js";
import { metaDescription } from "../../app/cobranca/[issuer]/[charge]/data.js";
import { faqPageJsonLd, serializeJsonLd } from "../../app/cobranca/[issuer]/[charge]/markdown.js";

const { aggregates, issuers, seoPages } = schema;

vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { container } = await import("../../lib/container.js");
const pageModule = await import("../../app/cobranca/[issuer]/[charge]/page.js");
const { default: ChargePage, generateMetadata, generateStaticParams, revalidate } = pageModule;

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

beforeEach(async () => {
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-cobranca-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-cobranca-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));
});

afterEach(async () => {
  await ctx.close();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function ctxFor(issuer: string, charge: string) {
  return { params: Promise.resolve({ issuer, charge }) };
}

async function renderPage(issuer: string, charge: string): Promise<string> {
  const element = await ChargePage(ctxFor(issuer, charge));
  return renderToStaticMarkup(element as React.ReactElement);
}

async function expectNotFound(issuer: string, charge: string) {
  await expect(ChargePage(ctxFor(issuer, charge)))
    .rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
}

async function issuerIdFor(slug: string): Promise<string> {
  const [row] = await ctx.db.select({ id: issuers.id }).from(issuers).where(eq(issuers.slug, slug));
  if (!row) throw new Error(`no issuer seeded for ${slug}`);
  return row.id;
}

/** Publishes an extra page, so a test can control the exact content it renders. */
async function publishPage(issuerSlug: string, chargeSlug: string, content: SeoPageContent, title = "Página de teste") {
  await ctx.db.insert(seoPages).values({
    id: newId("seo"),
    issuerId: await issuerIdFor(issuerSlug),
    chargeSlug,
    title,
    bodyMd: serializeSeoContent(content),
    status: "published",
  });
}

async function insertAggregate(issuerSlug: string, normalizedDesc: string, period: string, invoicesSeen: number, flagged: number) {
  await ctx.db.insert(aggregates).values({
    id: newId("agg"),
    issuerId: await issuerIdFor(issuerSlug),
    normalizedDesc,
    period,
    invoicesSeen,
    flagged,
  });
}

/**
 * The rendered text, with the markup removed. The headline is split around
 * the hand-drawn underline's `<span>`, so the full title is only contiguous
 * once the tags are gone - which is exactly how a reader (and a crawler)
 * sees it.
 */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** The one `application/ld+json` payload the page emits, still unparsed. */
function jsonLdPayload(html: string): string | null {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return match ? match[1]! : null;
}

describe("RF-280 - static with daily revalidation", () => {
  it("revalidates once a day", () => {
    expect(revalidate).toBe(86_400);
  });

  it("prerenders every published page", async () => {
    const params = await generateStaticParams();
    expect(params).toContainEqual({ issuer: "vivo-movel", charge: "skeelo" });
    expect(params.length).toBe(19);
  });

  it("does not break a build with no database: warns naming DATABASE_URL and prerenders nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(container).mockImplementation(() => { throw new Error("DATABASE_URL is not set"); });

    expect(await generateStaticParams()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("/cobranca");
  });
});

describe("the page itself", () => {
  it("renders the eyebrow, the issuer, the title and the intro", async () => {
    const html = await renderPage("vivo-movel", "skeelo");

    expect(html).toContain(copy.EYEBROW);
    expect(html).toContain(">Vivo<");
    expect(textOf(html)).toContain("Skeelo na conta da Vivo: o que é essa linha");
    expect(html).toContain("Skeelo é um serviço de audiolivros e leitura por assinatura");
  });

  it("marks the short question clause, and leaves the rest of the title plain", async () => {
    const html = await renderPage("vivo-movel", "skeelo");
    // The underline wraps everything after the last ": " and nothing else -
    // a phrase short enough that it can never wrap and break the stroke.
    expect(html).toMatch(/<span class="[^"]*">o que é essa linha<svg/);
    expect(html).toContain("Skeelo na conta da Vivo: <span");
  });

  it("still marks something when a title has no question clause", async () => {
    await publishPage("sky", "sem-dois-pontos", {
      intro: "Uma linha de teste.",
      sections: [{ heading: "Cabeçalho", paragraphs: ["Um parágrafo."] }],
      faq: [],
      provenance: "Origem do texto.",
    }, "Um título sem clausula final");

    const html = await renderPage("sky", "sem-dois-pontos");
    expect(html).toMatch(/<span class="[^"]*">Um título sem clausula final<svg/);
    expect(html.match(/<svg/g)?.length).toBe(1);
  });

  it("renders every section heading and every paragraph as real elements", async () => {
    const html = await renderPage("vivo-movel", "skeelo");

    expect(html).toContain("<h2>O que é essa linha</h2>");
    expect(html).toContain("<h2>Por que ela aparece na conta</h2>");
    expect(html).toContain("<h2>Perguntas frequentes</h2>");
    expect(html).toContain("<h2>Como esta página foi construída</h2>");
    expect(html).toContain("<h3>Dá para cancelar o Skeelo sem mexer no meu plano?</h3>");
    expect(html).toContain("é uma assinatura separada do plano de celular");
  });

  it("has exactly one h1", async () => {
    const html = await renderPage("vivo-movel", "skeelo");
    expect(html.match(/<h1/g)?.length).toBe(1);
  });

  it("uses the hand-drawn underline exactly once (§13.1's one accent)", async () => {
    const html = await renderPage("vivo-movel", "skeelo");
    expect(html.match(/<svg/g)?.length).toBe(1);
  });

  it("never interprets content as HTML - a page whose text carries a tag renders it as text", async () => {
    await publishPage("sky", "escape-visivel", {
      intro: "Uma linha com <b>marcação</b> no meio do texto.",
      sections: [{ heading: "Cabeçalho", paragraphs: ["Um parágrafo com <i>tags</i> dentro."] }],
      faq: [],
      provenance: "Origem do texto.",
    });

    const html = await renderPage("sky", "escape-visivel");
    expect(html).not.toContain("<b>marcação</b>");
    expect(html).toContain("&lt;b&gt;marcação&lt;/b&gt;");
  });

  it("ships no client JavaScript beyond the JSON-LD block", async () => {
    const html = await renderPage("vivo-movel", "skeelo");
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(html).toContain('<script type="application/ld+json">');
  });

  it("passes lintUserFacingText over everything it renders", async () => {
    const html = await renderPage("vivo-movel", "skeelo");
    expect(lintUserFacingText(html)).toMatchObject({ ok: true });
  });

  it("passes lintUserFacingText for every string this route introduces itself", () => {
    const strings = [
      copy.BRAND, copy.EYEBROW, copy.AGGREGATE_HEADING, copy.AGGREGATE_SEEN_LABEL,
      copy.AGGREGATE_FLAGGED_LABEL, copy.AGGREGATE_NOTE, copy.NOT_FOUND_MESSAGE, copy.BACK_HOME,
    ];
    for (const value of strings) {
      expect(lintUserFacingText(value), value).toMatchObject({ ok: true });
    }
  });
});

describe("addressing - only a published page is reachable", () => {
  it("404s for a draft row", async () => {
    const issuerId = await issuerIdFor("vivo-movel");
    await ctx.db
      .update(seoPages)
      .set({ status: "draft" })
      .where(and(eq(seoPages.issuerId, issuerId), eq(seoPages.chargeSlug, "skeelo")));

    await expectNotFound("vivo-movel", "skeelo");
  });

  it("404s for a charge that does not exist", async () => {
    await expectNotFound("vivo-movel", "nao-existe");
  });

  it("404s for an unknown issuer", async () => {
    await expectNotFound("nao-existe", "skeelo");
  });

  it("404s for a malformed slug", async () => {
    await expectNotFound("vivo-movel", "Skeelo");
  });
});

describe("RF-281 - the aggregate block", () => {
  it("does not render at all when there is no data", async () => {
    const html = await renderPage("vivo-movel", "skeelo");
    expect(html).not.toContain(copy.AGGREGATE_HEADING);
    expect(html).not.toContain(copy.AGGREGATE_SEEN_LABEL);
  });

  it("does not render at 49 invoices - not a zero, not an empty figure, nothing", async () => {
    await insertAggregate("vivo-movel", "SKEELO", "2026-07-01", 25, 5);
    await insertAggregate("vivo-movel", "SKEELO", "2026-08-01", 24, 4);

    const html = await renderPage("vivo-movel", "skeelo");
    expect(html).not.toContain(copy.AGGREGATE_HEADING);
    expect(html).not.toContain("49");
  });

  it("renders the count and the flagged share at 50", async () => {
    await insertAggregate("vivo-movel", "SKEELO", "2026-07-01", 25, 5);
    await insertAggregate("vivo-movel", "SKEELO", "2026-08-01", 25, 6);

    const html = await renderPage("vivo-movel", "skeelo");
    expect(html).toContain(copy.AGGREGATE_HEADING);
    expect(html).toContain(copy.AGGREGATE_SEEN_LABEL);
    expect(html).toContain(">50<");
    expect(html).toContain(copy.AGGREGATE_FLAGGED_LABEL);
    expect(html).toContain(">22%<");
    expect(html).toContain(copy.AGGREGATE_NOTE);
  });

  it("groups thousands the way the rest of the product does", async () => {
    await insertAggregate("vivo-movel", "SKEELO", "2026-07-01", 1284, 321);
    const html = await renderPage("vivo-movel", "skeelo");
    expect(html).toContain(">1.284<");
  });
});

describe("JSON-LD FAQPage - §18's rich-results gate", () => {
  it("emits a payload that parses, with one Question per entry, in order", async () => {
    const html = await renderPage("vivo-movel", "skeelo");
    const payload = jsonLdPayload(html);
    expect(payload).not.toBeNull();

    const parsed = JSON.parse(payload!);
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(parsed["@type"]).toBe("FAQPage");
    expect(parsed.mainEntity).toHaveLength(3);
    expect(parsed.mainEntity[0]).toEqual({
      "@type": "Question",
      name: "Dá para cancelar o Skeelo sem mexer no meu plano?",
      acceptedAnswer: {
        "@type": "Answer",
        text: expect.stringContaining("é uma assinatura separada do plano de celular"),
      },
    });
    expect(parsed.mainEntity[1].name).toBe("O item continuou aparecendo depois que eu cancelei. O que fazer?");
    expect(parsed.mainEntity[2].name).toBe("Skeelo Promo e Skeelo Top são a mesma coisa?");
  });

  // The payload is written as a plain text child rather than through
  // `dangerouslySetInnerHTML`, which works only because React emits a
  // <script>'s text raw. Pinned here: if React ever HTML-escaped it, the
  // payload would stop parsing and the rich result would be dropped
  // silently - a green gate measuring nothing.
  it("emits the payload byte-identically to serializeJsonLd, unescaped by React", async () => {
    const faq = [{
      question: 'Pergunta com "aspas", & e < sinal?',
      answer: 'Resposta com "aspas", & e < sinal, além de uma barra invertida \\ e um acento —.',
    }];
    await publishPage("sky", "jsonld-identico", {
      intro: "Uma linha de teste.",
      sections: [{ heading: "Cabeçalho", paragraphs: ["Um parágrafo."] }],
      faq,
      provenance: "Origem do texto.",
    });

    const html = await renderPage("sky", "jsonld-identico");
    expect(jsonLdPayload(html)).toBe(serializeJsonLd(faqPageJsonLd(faq)));
  });

  it("emits no script at all when the page has no FAQ", async () => {
    await publishPage("sky", "sem-faq", {
      intro: "Uma linha sem perguntas.",
      sections: [{ heading: "Cabeçalho", paragraphs: ["Um parágrafo."] }],
      faq: [],
      provenance: "Origem do texto.",
    });

    const html = await renderPage("sky", "sem-faq");
    expect(jsonLdPayload(html)).toBeNull();
    expect(html).not.toContain("<script");
  });

  it("a `<` in the content cannot close the script tag", async () => {
    const hostile = "Resposta com </script><script>alert(1)</script> no meio.";
    await publishPage("sky", "escape-jsonld", {
      intro: "Uma linha de teste.",
      sections: [{ heading: "Cabeçalho", paragraphs: ["Um parágrafo."] }],
      faq: [{ question: "Pergunta com < sinal?", answer: hostile }],
      provenance: "Origem do texto.",
    });

    const html = await renderPage("sky", "escape-jsonld");
    expect(html).not.toContain("<script>alert(1)</script>");

    const payload = jsonLdPayload(html);
    expect(payload).not.toBeNull();
    expect(payload).not.toContain("</script>");

    const parsed = JSON.parse(payload!);
    expect(parsed.mainEntity[0].name).toBe("Pergunta com < sinal?");
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe(hostile);
  });
});

describe("generateMetadata", () => {
  it("carries the title, a description derived from the intro, the canonical URL and openGraph", async () => {
    vi.stubEnv("APP_BASE_URL", "https://pentefino.com.br");
    const meta = await generateMetadata(ctxFor("vivo-movel", "skeelo"));

    expect(meta.title).toBe("Skeelo na conta da Vivo: o que é essa linha");
    expect(String(meta.description)).toMatch(/^Skeelo é um serviço de audiolivros/);
    expect(String(meta.description).length).toBeLessThanOrEqual(160);
    expect(String(meta.description).endsWith("…")).toBe(true);
    expect(meta.alternates?.canonical).toBe("https://pentefino.com.br/cobranca/vivo-movel/skeelo");
    expect(meta.openGraph?.title).toBe("Skeelo na conta da Vivo: o que é essa linha");
    expect(meta.openGraph?.description).toBe(meta.description);
    expect(meta.openGraph?.url).toBe("https://pentefino.com.br/cobranca/vivo-movel/skeelo");
  });

  it("hand-rolls no og:image - Task 6's opengraph-image.tsx is what fills it", async () => {
    const meta = await generateMetadata(ctxFor("vivo-movel", "skeelo"));
    expect(meta.openGraph).not.toHaveProperty("images");
  });

  it("keeps a page that does not exist out of the index", async () => {
    const meta = await generateMetadata(ctxFor("vivo-movel", "nao-existe"));
    expect(meta.title).toBe(copy.NOT_FOUND_MESSAGE);
    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });

  it("passes lintUserFacingText on the description it derives", async () => {
    const meta = await generateMetadata(ctxFor("vivo-movel", "skeelo"));
    expect(lintUserFacingText(String(meta.description))).toMatchObject({ ok: true });
    expect(metaDescription("uma frase curta")).toBe("uma frase curta");
  });
});
