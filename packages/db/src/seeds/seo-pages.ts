import { sql } from "drizzle-orm";
import { newId, serializeSeoContent } from "@pentefino/core";
import { issuers, seoPages } from "../schema.js";
import type { Database } from "../client.js";
import { SEO_PAGES } from "./seo-pages.content.js";

/**
 * RF-280's public content surface, seeded. The route
 * `/cobranca/[issuer]/[charge]` renders whatever is in `seo_pages`, so the
 * corpus in `seo-pages.content.ts` *is* the product's public answer to
 * "what is this line on my bill" — and this file is the only thing that
 * puts it there.
 *
 * ## What earns a page
 *
 * Only what CLAUDE.md §7 marks ✅ **confirmed** (2+ independent sources),
 * paired with the issuer the research actually observed it at. This is the
 * same line `rules/lexicon.ts` draws for the same reason, one level more
 * exposed: a seeded rule that is wrong shows one person a finding they can
 * dismiss, while a published page that is wrong says it to everyone who
 * searches the item's name, indefinitely, with the product's name on it.
 * §7.0 spells out the ceiling — this research read complaint text and
 * companies' own published pages, **never a real invoice** — so every page
 * carries that disclosure as its last block (`SEO_PROVENANCE`), and no page
 * claims more than "this is what this kind of line usually is, here is how
 * you check yours".
 *
 * ⚠️ single-source and ❔ needs-a-real-invoice entries get no page and are
 * not so much as named in one: §7.1.3's items (Abril News Digital, Babbel,
 * Vivo Recado, BandNews, Lionsgate, "NewsCo+"), §7.1.4's unconfirmed
 * aggregators (M4U/Multidisplay, Movile), §7.2's low-confidence prefixes
 * and §7.3's ⚠️ insurance names. `test/invariants/seo-content.spec.ts`
 * enforces that absence against the rendered text of every page, so the
 * corpus cannot quietly widen past what §7 confirmed.
 *
 * ## What has no page, and why it is not an oversight
 *
 * **§7.2 (payment-processor descriptor prefixes) and §7.3 (embedded card
 * insurance) — the highest-confidence material in the whole lexicon — get
 * no page at all.** `seo_pages.issuer_id` is `NOT NULL` and references
 * `issuers`, and §20.1 seeds six telecom operators and no card issuer. Both
 * of those sections are about a *card* statement, so there is no row to
 * hang them on. Inventing an issuer ("Cartões em geral", a placeholder
 * bank) to unlock the page would put a fabricated row in the table
 * detection reads from (`issuers.aliases`, `issuers.cnpj`) purely to satisfy
 * a foreign key — exactly the kind of confidently-wrong data RF-106 exists
 * to prevent. The pages wait for the first real card issuer; this comment
 * is the record that they are missing on purpose.
 *
 * **"Vivo Meditação Lite" does get a page**, carrying §7.4's own caveat
 * forward: the name contains "meditação", and §7.4 decided — out loud
 * rather than in silence — to keep it, because it is a secular wellness app
 * branded by the operator and not a service of any religious denomination.
 * INV-006 is about inferring a sensitive category *from a user's invoice*,
 * which a public page describing a product does not do. If that judgement
 * is ever revisited, this is one entry in `SEO_PAGES` and one page, and it
 * can be removed without touching anything else.
 *
 * ## Idempotence and failure mode
 *
 * Upserts by `(issuerId, chargeSlug)` — the table's own unique index — the
 * way `issuers.ts` upserts by slug, so a redeploy corrects text in place
 * instead of duplicating rows. The issuer id is resolved by slug at seed
 * time and a missing issuer **throws**: a page silently skipped because its
 * issuer row was not there is a page that is silently missing from the
 * site, and nothing downstream would ever report it.
 */
export async function seedSeoPages(db: Database): Promise<void> {
  const issuerRows = await db.select({ id: issuers.id, slug: issuers.slug }).from(issuers);
  const issuerIdBySlug = new Map(issuerRows.map((row) => [row.slug, row.id]));

  for (const page of SEO_PAGES) {
    const issuerId = issuerIdBySlug.get(page.issuerSlug);
    if (issuerId === undefined) {
      throw new Error(
        `seedSeoPages: no issuer row for slug ${JSON.stringify(page.issuerSlug)} ` +
          `(page ${JSON.stringify(page.chargeSlug)}). Run seedIssuers first.`,
      );
    }

    // Serialised once and used by both the insert and the update branch: the
    // two must write the same bytes, and computing it twice is one edit away
    // from them not doing so.
    const bodyMd = serializeSeoContent(page.content);

    await db
      .insert(seoPages)
      .values({
        id: newId("seo"),
        issuerId,
        chargeSlug: page.chargeSlug,
        title: page.title,
        bodyMd,
        status: "published",
      })
      .onConflictDoUpdate({
        target: [seoPages.issuerId, seoPages.chargeSlug],
        set: {
          title: page.title,
          bodyMd,
          status: "published",
          updatedAt: sql`now()`,
        },
      });
  }
}
