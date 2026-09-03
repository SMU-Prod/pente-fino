import { and, eq } from "drizzle-orm";
import { isSeoChargeSlug, parseSeoContent, seoChargeSlug, type SeoPageContent } from "@pentefino/core";
// eslint-disable-next-line pentefino/require-with-user -- INV-008 asks "whose rows are these?", and for the three tables this file reads the answer is "nobody's": seo_pages is published editorial content keyed by (issuer_id, charge_slug), issuers is the seeded operator catalogue, and aggregates counts invoices across every sender. None of the three has a user_id or session_id column, so there is no ownership filter for withUser to apply - unlike apps/web/app/l/[token]/data.ts, whose exception is about reaching a user-owned invoice through a capability token instead of a session. This file never selects from invoices, invoice_items, findings, cases or events, so the exception cannot widen into one that does.
import { schema } from "@pentefino/db";
import type { Database } from "@pentefino/db";

const { aggregates, issuers, seoPages } = schema;

/**
 * Everything RF-280's public page is allowed to know: one `seo_pages` row,
 * parsed, plus the issuer it hangs off. Narrow on purpose, the same way
 * `PublicReport` is in `app/l/[token]/data.ts` - there is no field here a
 * bill, a person or a session could ever occupy, because none of the three
 * tables this module reads carries one.
 */
export type ChargePage = {
  /** Needed by `loadChargeAggregate`; never rendered. */
  issuerId: string;
  issuerSlug: string;
  /** `issuers.displayName`, e.g. "Vivo". Seeded, closed-set editorial text. */
  issuerName: string;
  chargeSlug: string;
  title: string;
  content: SeoPageContent;
};

/** One entry of `generateStaticParams()`, i.e. one URL of this route. */
export type ChargeParams = { issuer: string; charge: string };

/** RF-281's figures, already past the floor - see `loadChargeAggregate`. */
export type ChargeAggregate = { invoicesSeen: number; flagged: number };

/**
 * RF-281: "dado agregado exibido apenas com `invoicesSeen ≥ 50` no
 * período". The gate lives in `loadChargeAggregate` rather than in the
 * component, so there is no path that renders a figure the loader did not
 * already clear - a component-side check is one refactor away from being
 * skipped by a second caller.
 */
export const AGGREGATE_MIN_INVOICES = 50;

/**
 * Google truncates a description around 155-160 characters; anything past
 * that is written for nobody. The value is a cap, not a target: a shorter
 * intro is emitted whole.
 */
export const META_DESCRIPTION_MAX = 160;

/**
 * The `<meta name="description">` for a page, derived from its intro
 * paragraph.
 *
 * Truncation is on a word boundary and the result is always a literal
 * prefix of the intro plus an ellipsis - no trailing punctuation is
 * stripped and no word is ever cut in half. Keeping it a strict prefix is
 * what makes the tag verifiable: whatever the description says, the page
 * says the same thing in the same words, which is the whole point of a
 * description a search engine will show beside the title.
 *
 * The one degenerate case - a first "word" longer than the whole budget -
 * falls back to a hard cut, because the alternative is an empty
 * description.
 */
export function metaDescription(intro: string, maxLength = META_DESCRIPTION_MAX): string {
  const text = intro.trim().replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;

  // One character of the budget belongs to the ellipsis.
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${head}…`;
}

/**
 * **The one place `aggregates` and `seo_pages` are related to each other.**
 *
 * They share no key: `seo_pages` carries `charge_slug` (a URL segment,
 * authored by hand in the seed) and `aggregates` carries `normalized_desc`
 * (`normalizeDescription`'s output over an invoice line, written by the
 * pipeline). Nothing in the schema maps one onto the other, so the relation
 * has to be *defined* somewhere - and this is that somewhere.
 *
 * The definition: an `aggregates` row belongs to a page when its normalised
 * description, lowercased and hyphen-joined, is exactly that page's
 * `charge_slug`. `normalizeDescription` already emits accent-free A-Z0-9
 * words separated by single spaces, so lowercasing and replacing the spaces
 * is a pure re-encoding of the same string, not a second normalisation
 * (there is exactly one of those in this codebase,
 * `@pentefino/core`'s `normalizeDescription`, and this is not it).
 * `seoChargeSlug` - the single definition of the slug shape, shared with the
 * seed and with the route's own URL check - is what says whether the result
 * is a slug at all; anything it rejects returns `null` here.
 *
 * **This relation fails closed, and that is deliberate.** A charge whose
 * normalised description slugifies to something other than the page's slug
 * simply never contributes to that page's aggregate: "SKEELO TOP" does not
 * count towards `/cobranca/vivo-movel/skeelo`, and neither would a page
 * whose author picked a slug that reads better than the billed text. The
 * failure mode is therefore "no number on the page" (the block does not
 * render at all, exactly as RF-281 already requires below 50) rather than
 * "a number built from the wrong rows". Missing is recoverable by a human
 * looking at the page; wrong is a published claim about how often something
 * is billed, which is the one thing a public page must never get wrong.
 */
export function chargeSlugForNormalizedDesc(normalizedDesc: string): string | null {
  const candidate = normalizedDesc.trim().toLowerCase().replace(/\s+/g, "-");
  if (!isSeoChargeSlug(candidate)) return null;
  return seoChargeSlug(candidate);
}

/** Just the two variables `siteBaseUrl` reads, so a test can pass a literal. */
export type SiteEnv = { APP_BASE_URL?: string | undefined; NODE_ENV?: string | undefined };

/**
 * The absolute origin this site is served from, for `alternates.canonical`.
 *
 * Deliberately **not** `lib/container.ts`'s `resolveAppBaseUrl`, which
 * throws in production when `APP_BASE_URL` is unset. That posture is right
 * for the thing it guards - a link inside an e-mail that has already been
 * sent cannot be taken back - and wrong here: a canonical tag pointing at
 * the wrong origin is corrected by the next deploy, while throwing would
 * mean `next build` fails for a variable no other part of the public
 * surface needs. So this one warns instead, loudly and by name, and only
 * where the wrong value would actually be served (production).
 *
 * E10 Task 5 introduces `lib/site.ts` for the sitemap and `robots.txt`,
 * which need the same origin; this function is the seam it should absorb.
 */
export function siteBaseUrl(env: SiteEnv = process.env): string {
  const configured = env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (env.NODE_ENV === "production") {
    console.warn(
      "[pentefino] APP_BASE_URL is not set, so every canonical URL under /cobranca points at " +
        "http://localhost:3000. Set APP_BASE_URL to the site's real origin.",
    );
  }
  return "http://localhost:3000";
}

/** This route's own path for a page, without an origin. */
export function canonicalPath(issuerSlug: string, chargeSlug: string): string {
  return `/cobranca/${issuerSlug}/${chargeSlug}`;
}

export function canonicalUrl(
  issuerSlug: string,
  chargeSlug: string,
  env: SiteEnv = process.env,
): string {
  return `${siteBaseUrl(env)}${canonicalPath(issuerSlug, chargeSlug)}`;
}

/**
 * RF-280's loader: one published page, by issuer slug and charge slug.
 *
 * Both gates are in the `WHERE` clause, not checked afterwards in component
 * code - the same shape `loadPublicReport` uses for the same reason:
 *
 *   - `issuers.slug` and `seo_pages.charge_slug` must both match exactly;
 *   - `status = 'published'` - a draft row is not reachable by URL at all.
 *     A draft is text somebody is still writing, and the difference between
 *     "not published yet" and "published" is the whole reason the column
 *     exists.
 *
 * Both URL segments are checked against `isSeoChargeSlug` first, so a
 * malformed segment (an escaped path, an uppercase slug, anything that
 * could never have been written by the seed) 404s without a query. The seed
 * validates `charge_slug` with the very same function, which is what makes
 * "the shape the URL allows" and "the shape the table holds" one rule
 * instead of two that can drift.
 *
 * `parseSeoContent` is allowed to throw. An unparseable `body_md` is a
 * corrupted publish, not a missing page: 404ing on it would hide a broken
 * row behind a status code that means "no such page", and rendering it
 * partially would put half a disclosure in front of a reader. The seed's
 * own round-trip test (`packages/db/test/seeds-seo.test.ts`) is what keeps
 * this from ever firing for seeded content.
 */
export async function loadChargePage(
  issuerSlug: string,
  chargeSlug: string,
  db: Database,
): Promise<ChargePage | null> {
  if (!isSeoChargeSlug(issuerSlug) || !isSeoChargeSlug(chargeSlug)) return null;

  const [row] = await db
    .select({
      issuerId: issuers.id,
      issuerName: issuers.displayName,
      chargeSlug: seoPages.chargeSlug,
      title: seoPages.title,
      bodyMd: seoPages.bodyMd,
    })
    .from(seoPages)
    .innerJoin(issuers, eq(seoPages.issuerId, issuers.id))
    .where(
      and(
        eq(issuers.slug, issuerSlug),
        eq(seoPages.chargeSlug, chargeSlug),
        eq(seoPages.status, "published"),
      ),
    );
  if (!row) return null;

  return {
    issuerId: row.issuerId,
    issuerSlug,
    issuerName: row.issuerName,
    chargeSlug: row.chargeSlug,
    title: row.title,
    content: parseSeoContent(row.bodyMd),
  };
}

/**
 * Every published page's URL, for `generateStaticParams()`. Drafts are
 * excluded by the same clause `loadChargePage` uses, so a row can never be
 * prerendered into a page the loader would then refuse to serve.
 */
export async function loadPublishedChargeParams(db: Database): Promise<ChargeParams[]> {
  const rows = await db
    .select({ issuer: issuers.slug, charge: seoPages.chargeSlug })
    .from(seoPages)
    .innerJoin(issuers, eq(seoPages.issuerId, issuers.id))
    .where(eq(seoPages.status, "published"));

  return rows.map((row) => ({ issuer: row.issuer, charge: row.charge }));
}

/**
 * RF-281's figures for one page, or `null` when they may not be shown.
 *
 * **What "no período" means here: every period stored.** `aggregates` is
 * keyed `(issuer_id, normalized_desc, period)` and `period` is a `date`,
 * one row per billing month. This sums *all* of a charge's rows rather than
 * a trailing window, for two reasons. First, this page is statically
 * generated and revalidated daily (`revalidate = 86400`): a window measured
 * from "now" would make the same sentence show a different number depending
 * on when the build happened to run, which no reader can see and no test
 * can pin down without freezing a clock. Second, RF-281's threshold asks
 * "have enough invoices been seen to say anything at all", and the honest
 * answer to that is cumulative. The consequence, stated rather than
 * implied: a charge that stopped being billed years ago keeps its
 * historical count, so the copy beside the figure says the number covers
 * every invoice sent so far and never claims it describes the current
 * cycle. If a retention or window policy ever arrives, this function is the
 * single place it lands.
 *
 * Rows are filtered by issuer in SQL and by charge in TypeScript, through
 * `chargeSlugForNormalizedDesc` - the slug rule is a shared TypeScript
 * function and re-encoding it in SQL would create a second definition that
 * could drift from the one the seed and the URL check already share.
 *
 * `aggregates` is empty today (nothing writes it yet in this slice), so
 * every call returns `null` and no page shows a figure. That is the correct
 * output, not a gap.
 */
export async function loadChargeAggregate(
  issuerId: string,
  chargeSlug: string,
  db: Database,
): Promise<ChargeAggregate | null> {
  const rows = await db
    .select({
      normalizedDesc: aggregates.normalizedDesc,
      invoicesSeen: aggregates.invoicesSeen,
      flagged: aggregates.flagged,
    })
    .from(aggregates)
    .where(eq(aggregates.issuerId, issuerId));

  let invoicesSeen = 0;
  let flagged = 0;
  for (const row of rows) {
    if (chargeSlugForNormalizedDesc(row.normalizedDesc) !== chargeSlug) continue;
    invoicesSeen += row.invoicesSeen;
    flagged += row.flagged;
  }

  if (invoicesSeen < AGGREGATE_MIN_INVOICES) return null;
  return { invoicesSeen, flagged };
}
