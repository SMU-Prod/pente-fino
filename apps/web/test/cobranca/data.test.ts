import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId, parseSeoContent, serializeSeoContent } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import {
  AGGREGATE_MIN_INVOICES,
  META_DESCRIPTION_MAX,
  canonicalPath,
  canonicalUrl,
  chargeSlugForNormalizedDesc,
  loadChargeAggregate,
  loadChargePage,
  loadPublishedChargeParams,
  metaDescription,
  siteBaseUrl,
} from "../../app/cobranca/[issuer]/[charge]/data.js";

const { aggregates, issuers, seoPages } = schema;

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
  vi.restoreAllMocks();
});

async function issuerIdFor(slug: string): Promise<string> {
  const [row] = await ctx.db.select({ id: issuers.id }).from(issuers).where(eq(issuers.slug, slug));
  if (!row) throw new Error(`no issuer seeded for ${slug}`);
  return row.id;
}

async function insertAggregate(input: {
  issuerId: string;
  normalizedDesc: string;
  period: string;
  invoicesSeen: number;
  flagged?: number;
}) {
  await ctx.db.insert(aggregates).values({
    id: newId("agg"),
    issuerId: input.issuerId,
    normalizedDesc: input.normalizedDesc,
    period: input.period,
    invoicesSeen: input.invoicesSeen,
    flagged: input.flagged ?? 0,
  });
}

describe("metaDescription - derived from the intro, truncated on a word boundary", () => {
  it("returns a short intro unchanged", () => {
    const intro = "Skeelo é um serviço de audiolivros cobrado dentro da conta.";
    expect(metaDescription(intro)).toBe(intro);
  });

  it("collapses runs of whitespace so the tag never carries a line break", () => {
    expect(metaDescription("uma  frase\ncom   espaços")).toBe("uma frase com espaços");
  });

  it("never exceeds the limit and never cuts a word in half", () => {
    const intro =
      "Skeelo é um serviço de audiolivros e leitura por assinatura que pode ser cobrado dentro da conta da Vivo, " +
      "na parte da fatura reservada aos serviços digitais, e esta página explica o que costuma ser essa linha.";
    const result = metaDescription(intro);

    expect(result.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(result.endsWith("…")).toBe(true);
    // The text before the ellipsis must be a prefix of the intro that ends
    // exactly where a word ends - i.e. the next character in the intro is a
    // space, never a letter.
    const head = result.slice(0, -1);
    expect(intro.startsWith(head)).toBe(true);
    expect(intro.charAt(head.length)).toBe(" ");
  });

  it("honours a caller-supplied limit", () => {
    const result = metaDescription("uma frase bastante comprida para o limite", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe("uma frase bastante…");
  });
});

describe("chargeSlugForNormalizedDesc - the one documented aggregates <-> seo_pages relation", () => {
  it("slugifies a single-word normalised description", () => {
    expect(chargeSlugForNormalizedDesc("SKEELO")).toBe("skeelo");
  });

  it("slugifies a multi-word normalised description with hyphens", () => {
    expect(chargeSlugForNormalizedDesc("SERVICOS DIGITAIS III")).toBe("servicos-digitais-iii");
  });

  it("returns null - never a guess - for a description that cannot be a slug", () => {
    expect(chargeSlugForNormalizedDesc("")).toBeNull();
    expect(chargeSlugForNormalizedDesc("   ")).toBeNull();
    expect(chargeSlugForNormalizedDesc("R$ 10")).toBeNull();
    expect(chargeSlugForNormalizedDesc("SKEELO - TOP")).toBeNull();
  });
});

describe("canonical URL", () => {
  it("builds the route's own path", () => {
    expect(canonicalPath("vivo-movel", "skeelo")).toBe("/cobranca/vivo-movel/skeelo");
  });

  it("uses APP_BASE_URL when it is set, without doubling the slash", () => {
    expect(canonicalUrl("vivo-movel", "skeelo", { APP_BASE_URL: "https://pentefino.com.br/" }))
      .toBe("https://pentefino.com.br/cobranca/vivo-movel/skeelo");
  });

  it("falls back to the dev origin, quietly, when APP_BASE_URL is unset outside production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(siteBaseUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns loudly, naming APP_BASE_URL, when it is unset in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(siteBaseUrl({ NODE_ENV: "production" })).toBe("http://localhost:3000");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("APP_BASE_URL");
  });
});

describe("loadChargePage", () => {
  it("returns a published page, joined to its issuer, with the body parsed back", async () => {
    const page = await loadChargePage("vivo-movel", "skeelo", ctx.db);

    expect(page).not.toBeNull();
    expect(page?.issuerSlug).toBe("vivo-movel");
    expect(page?.issuerName).toBe("Vivo");
    expect(page?.chargeSlug).toBe("skeelo");
    expect(page?.title).toBe("Skeelo na conta da Vivo: o que é essa linha");
    expect(page?.content.intro).toMatch(/^Skeelo é um serviço/);
    expect(page?.content.sections.length).toBeGreaterThan(0);
    expect(page?.content.faq.length).toBeGreaterThan(0);
    expect(page?.content.provenance.length).toBeGreaterThan(0);
  });

  it("round-trips: the parsed content re-serialises to exactly what the row stores", async () => {
    const page = await loadChargePage("vivo-movel", "skeelo", ctx.db);
    const [row] = await ctx.db
      .select({ bodyMd: seoPages.bodyMd })
      .from(seoPages)
      .where(eq(seoPages.chargeSlug, "skeelo"));

    expect(serializeSeoContent(page!.content)).toBe(row!.bodyMd);
    expect(parseSeoContent(row!.bodyMd)).toEqual(page!.content);
  });

  it("returns null for a draft row - a draft page is not reachable by URL", async () => {
    const issuerId = await issuerIdFor("vivo-movel");
    await ctx.db
      .update(seoPages)
      .set({ status: "draft" })
      .where(and(eq(seoPages.issuerId, issuerId), eq(seoPages.chargeSlug, "skeelo")));

    expect(await loadChargePage("vivo-movel", "skeelo", ctx.db)).toBeNull();
  });

  it("returns null for a charge that does not exist on that issuer", async () => {
    expect(await loadChargePage("vivo-movel", "nao-existe", ctx.db)).toBeNull();
  });

  it("returns null when the page exists but under a different issuer", async () => {
    expect(await loadChargePage("sky", "skeelo", ctx.db)).toBeNull();
  });

  it("returns null for a malformed slug, without asking the database", async () => {
    const broken = { select: () => { throw new Error("the database must not be touched"); } } as unknown as typeof ctx.db;
    expect(await loadChargePage("Vivo Movel", "skeelo", broken)).toBeNull();
    expect(await loadChargePage("vivo-movel", "../secret", broken)).toBeNull();
  });
});

describe("loadPublishedChargeParams", () => {
  it("returns one { issuer, charge } for every published row", async () => {
    const params = await loadPublishedChargeParams(ctx.db);
    const published = await ctx.db
      .select({ id: seoPages.id })
      .from(seoPages)
      .where(eq(seoPages.status, "published"));

    expect(params.length).toBe(published.length);
    expect(params.length).toBeGreaterThan(0);
    expect(params).toContainEqual({ issuer: "vivo-movel", charge: "skeelo" });
  });

  it("leaves a draft row out", async () => {
    const issuerId = await issuerIdFor("vivo-movel");
    await ctx.db
      .update(seoPages)
      .set({ status: "draft" })
      .where(and(eq(seoPages.issuerId, issuerId), eq(seoPages.chargeSlug, "skeelo")));

    const params = await loadPublishedChargeParams(ctx.db);
    expect(params).not.toContainEqual({ issuer: "vivo-movel", charge: "skeelo" });
  });
});

describe("loadChargeAggregate - RF-281's floor", () => {
  it("returns null when there is no aggregates row at all", async () => {
    const issuerId = await issuerIdFor("vivo-movel");
    expect(await loadChargeAggregate(issuerId, "skeelo", ctx.db)).toBeNull();
  });

  it("returns null one invoice below the floor, summing every period", async () => {
    const issuerId = await issuerIdFor("vivo-movel");
    await insertAggregate({ issuerId, normalizedDesc: "SKEELO", period: "2026-07-01", invoicesSeen: 25, flagged: 5 });
    await insertAggregate({ issuerId, normalizedDesc: "SKEELO", period: "2026-08-01", invoicesSeen: 24, flagged: 4 });

    expect(await loadChargeAggregate(issuerId, "skeelo", ctx.db)).toBeNull();
  });

  it("returns the summed counts exactly at the floor", async () => {
    const issuerId = await issuerIdFor("vivo-movel");
    await insertAggregate({ issuerId, normalizedDesc: "SKEELO", period: "2026-07-01", invoicesSeen: 25, flagged: 5 });
    await insertAggregate({ issuerId, normalizedDesc: "SKEELO", period: "2026-08-01", invoicesSeen: 25, flagged: 6 });

    expect(await loadChargeAggregate(issuerId, "skeelo", ctx.db))
      .toEqual({ invoicesSeen: AGGREGATE_MIN_INVOICES, flagged: 11 });
  });

  it("fails closed: a normalised description that slugifies differently never counts", async () => {
    const issuerId = await issuerIdFor("vivo-movel");
    await insertAggregate({ issuerId, normalizedDesc: "SKEELO", period: "2026-07-01", invoicesSeen: 50, flagged: 10 });
    await insertAggregate({ issuerId, normalizedDesc: "SKEELO TOP", period: "2026-07-01", invoicesSeen: 900, flagged: 900 });

    expect(await loadChargeAggregate(issuerId, "skeelo", ctx.db))
      .toEqual({ invoicesSeen: 50, flagged: 10 });
  });

  it("never counts another issuer's rows", async () => {
    const vivo = await issuerIdFor("vivo-movel");
    const sky = await issuerIdFor("sky");
    await insertAggregate({ issuerId: sky, normalizedDesc: "SKEELO", period: "2026-07-01", invoicesSeen: 900, flagged: 900 });

    expect(await loadChargeAggregate(vivo, "skeelo", ctx.db)).toBeNull();
  });
});
