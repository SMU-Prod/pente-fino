import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { isSeoChargeSlug, parseSeoContent } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import { schema } from "../src/index.js";
import { seedAll, seedIssuers, seedSeoPages } from "../src/seeds/index.js";
import { SEO_ISSUER_VOICES, SEO_PAGES } from "../src/seeds/seo-pages.content.js";

/**
 * The corpus as a flat list of `issuer/charge` pairs, written out by hand
 * rather than derived from `SEO_PAGES`. Deriving it would make the test
 * agree with the corpus no matter what the corpus said — including after an
 * accidental deletion. This list is the intended shipping set of E10 Task 2,
 * and a diff here is meant to be read, not auto-resolved.
 */
const EXPECTED_PAGES = [
  "claro-movel/servicos-de-valor-adicionado",
  "claro-movel/ubook",
  "vivo-movel/clube-de-revistas",
  "vivo-movel/cobranca-de-servicos-de-terceiros",
  "vivo-movel/funkids",
  "vivo-movel/goread",
  "vivo-movel/hube-jornais",
  "vivo-movel/mcafee",
  "vivo-movel/nba-basico",
  "vivo-movel/servicos-de-valor-adicionado",
  "vivo-movel/servicos-digitais-iii",
  "vivo-movel/skeelo",
  "vivo-movel/tdata",
  "vivo-movel/vivo-meditacao-lite",
  "tim-movel/servicos-de-valor-adicionado",
  "tim-movel/ubook",
  "oi/servicos-de-valor-adicionado",
  "sky/servicos-de-valor-adicionado",
  "algar/servicos-de-valor-adicionado",
].sort();

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

/** Every seeded page as `issuerSlug/chargeSlug`, read back from the database. */
async function seededPageKeys(): Promise<string[]> {
  const rows = await ctx.db
    .select({ issuerSlug: schema.issuers.slug, chargeSlug: schema.seoPages.chargeSlug })
    .from(schema.seoPages)
    .innerJoin(schema.issuers, eq(schema.seoPages.issuerId, schema.issuers.id));
  return rows.map((row) => `${row.issuerSlug}/${row.chargeSlug}`).sort();
}

describe("seo_pages seed", () => {
  it("publishes exactly the confirmed (issuer, charge) pairs of CLAUDE.md §7", async () => {
    expect(await seededPageKeys()).toEqual(EXPECTED_PAGES);
  });

  it("gives every page the published status, so the route can serve it", async () => {
    const rows = await ctx.db.select().from(schema.seoPages);
    expect(rows).not.toHaveLength(0);
    expect(rows.every((row) => row.status === "published")).toBe(true);
  });

  it("is idempotent, so a redeploy corrects text in place instead of duplicating", async () => {
    const before = await ctx.db.select().from(schema.seoPages);
    await seedSeoPages(ctx.db);
    await seedSeoPages(ctx.db);
    const after = await ctx.db.select().from(schema.seoPages);
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });

  it("re-seeds corrected text onto the row that already exists", async () => {
    await ctx.db.update(schema.seoPages).set({ title: "texto trocado à mão", status: "draft" });
    await seedSeoPages(ctx.db);
    const rows = await ctx.db.select().from(schema.seoPages);
    expect(rows.some((r) => r.title === "texto trocado à mão")).toBe(false);
    expect(rows.every((r) => r.status === "published")).toBe(true);
  });

  // The round trip is the contract with the route: `parseSeoContent` is what
  // `/cobranca/[issuer]/[charge]` calls on the stored column, so a page whose
  // `body_md` does not parse back to what was authored is a broken page —
  // either a throw at request time or, worse, a page missing a section
  // nobody noticed.
  it("stores every page's body so it parses back to exactly the authored content", async () => {
    const rows = await ctx.db
      .select({ issuerSlug: schema.issuers.slug, chargeSlug: schema.seoPages.chargeSlug, bodyMd: schema.seoPages.bodyMd })
      .from(schema.seoPages)
      .innerJoin(schema.issuers, eq(schema.seoPages.issuerId, schema.issuers.id));

    expect(rows).toHaveLength(SEO_PAGES.length);
    for (const row of rows) {
      const authored = SEO_PAGES.find(
        (p) => p.issuerSlug === row.issuerSlug && p.chargeSlug === row.chargeSlug,
      );
      expect(authored, `${row.issuerSlug}/${row.chargeSlug} has no authored entry`).toBeDefined();
      expect(parseSeoContent(row.bodyMd), `${row.issuerSlug}/${row.chargeSlug}`)
        .toEqual(authored?.content);
    }
  });

  it("gives every page a valid charge slug, unique within its issuer", async () => {
    const seen = new Set<string>();
    for (const page of SEO_PAGES) {
      expect(isSeoChargeSlug(page.chargeSlug), `${page.issuerSlug}/${page.chargeSlug}`).toBe(true);
      const key = `${page.issuerSlug}/${page.chargeSlug}`;
      expect(seen.has(key), `duplicate page ${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(SEO_PAGES.length);
  });

  it("references only issuer slugs §20.1 actually seeds", async () => {
    const issuerRows = await ctx.db.select({ slug: schema.issuers.slug }).from(schema.issuers);
    const known = new Set(issuerRows.map((r) => r.slug));
    const unknown = [...new Set(SEO_PAGES.map((p) => p.issuerSlug))].filter((s) => !known.has(s));
    expect(unknown).toEqual([]);
  });

  // The corpus quotes bill section names in prose ("procure a seção
  // 'Serviços Digitais'"), and those names are a second copy of what
  // `issuers.ts` seeds onto `issuers.sections`. A rename there must break
  // this, not silently leave nineteen pages pointing a reader at a section
  // their bill does not have.
  it("quotes only the section names the issuers seed actually carries", async () => {
    const rows = await ctx.db
      .select({ slug: schema.issuers.slug, sections: schema.issuers.sections })
      .from(schema.issuers);
    const seeded = new Map(rows.map((r) => [r.slug, r.sections ?? []]));
    for (const [slug, spoken] of Object.entries(SEO_ISSUER_VOICES)) {
      expect(seeded.has(slug), `no issuer row for ${slug}`).toBe(true);
      expect([...spoken.sections].sort(), slug).toEqual([...(seeded.get(slug) ?? [])].sort());
    }
  });

  // The six "what is an SVA section" pages name the items this corpus has a
  // page for, so a reader on the TIM page is not told there is nothing to
  // name while `tim-movel/ubook` ships. A pointer to a page that does *not*
  // exist is the same defect the other way round, and would be invisible —
  // nothing renders these as links, so nothing would 404.
  it("points only at item pages that exist at the same issuer", () => {
    const ITEM_PAGE_BY_NAME: Record<string, string> = {
      Skeelo: "skeelo",
      GoRead: "goread",
      "Hube Jornais": "hube-jornais",
      "NBA Básico": "nba-basico",
      "Clube de Revistas": "clube-de-revistas",
      FunKids: "funkids",
      McAfee: "mcafee",
      "Vivo Meditação Lite": "vivo-meditacao-lite",
      TDATA: "tdata",
      Ubook: "ubook",
      "TIM Livros": "ubook",
    };
    const have = new Set(SEO_PAGES.map((p) => `${p.issuerSlug}/${p.chargeSlug}`));

    for (const page of SEO_PAGES.filter((p) => p.chargeSlug === "servicos-de-valor-adicionado")) {
      const text = [
        page.content.intro,
        ...page.content.sections.flatMap((s) => s.paragraphs),
        ...page.content.faq.flatMap((f) => [f.question, f.answer]),
      ].join(" ");
      for (const [name, chargeSlug] of Object.entries(ITEM_PAGE_BY_NAME)) {
        if (!text.includes(name)) continue;
        const target = `${page.issuerSlug}/${chargeSlug}`;
        expect(have.has(target), `${page.issuerSlug} SVA page names ${name}, but ${target} has no page`)
          .toBe(true);
      }
    }
  });

  // Six URLs emitting the same JSON-LD `FAQPage` is what gets a rich result
  // dropped, and §18's gate for E10 is "Rich results válidos". The FAQ is the
  // one block that must not repeat across pages.
  it("gives no two pages the same FAQ, so no two emit the same FAQPage", () => {
    const seen = new Map<string, string>();
    for (const page of SEO_PAGES) {
      const key = `${page.issuerSlug}/${page.chargeSlug}`;
      const fingerprint = JSON.stringify(page.content.faq);
      const previous = seen.get(fingerprint);
      expect(previous, `${key} has the same FAQ as ${previous}`).toBeUndefined();
      seen.set(fingerprint, key);
    }
  });

  it("gives every page a non-empty title and an FAQ the JSON-LD can be built from", async () => {
    for (const page of SEO_PAGES) {
      const key = `${page.issuerSlug}/${page.chargeSlug}`;
      expect(page.title.trim().length, key).toBeGreaterThan(0);
      // RF-283 emits a `FAQPage` "onde houver perguntas"; the brief asks for
      // 2 to 4 real questions on every page, so "where there are questions"
      // must be everywhere.
      expect(page.content.faq.length, key).toBeGreaterThanOrEqual(2);
      expect(page.content.faq.length, key).toBeLessThanOrEqual(4);
    }
  });

  // A page whose issuer row is missing would be a page missing from the
  // site with nothing anywhere reporting it, so the seed throws instead.
  it("throws rather than skipping a page whose issuer row is missing", async () => {
    const bare = await createTestDb();
    try {
      await bare.db.delete(schema.seoPages);
      await bare.db.delete(schema.issuers);
      await expect(seedSeoPages(bare.db)).rejects.toThrow(/no issuer row for slug/);
    } finally {
      await bare.close();
    }
  });

  it("runs inside seedAll, after the issuers it depends on", async () => {
    const fresh = await createTestDb();
    try {
      await fresh.db.delete(schema.seoPages);
      await seedIssuers(fresh.db);
      await seedAll(fresh.db);
      const rows = await fresh.db.select().from(schema.seoPages);
      expect(rows).toHaveLength(SEO_PAGES.length);
    } finally {
      await fresh.close();
    }
  });
});
