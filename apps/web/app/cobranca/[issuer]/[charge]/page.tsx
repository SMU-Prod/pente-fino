import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { container } from "@/lib/container.js";
import * as copy from "./copy.js";
import {
  canonicalUrl, loadChargeAggregate, loadChargePage, loadPublishedChargeParams,
  metaDescription, type ChargeParams,
} from "./data.js";
import { FaqJsonLd, SeoFaq, SeoProvenance, SeoSections } from "./markdown.js";
import styles from "./cobranca.module.css";

/**
 * RF-280: the public answer to "o que é essa linha na minha conta".
 *
 * Static with daily revalidation, content out of `seo_pages`, reachable
 * with no session and no cookie at all — the same posture as
 * `app/l/[token]`, minus even a capability token, because there is nothing
 * private here: the corpus is editorial text authored in
 * `packages/db/src/seeds/seo-pages.content.ts` and published deliberately.
 * See `data.ts`'s `require-with-user` note for why INV-008's scoping
 * question does not arise for the three tables this route reads.
 *
 * **Zero client JavaScript.** No `"use client"`, no state, no effect, no
 * event handler anywhere in this tree — the whole page is server-rendered
 * markup plus one `application/ld+json` block, which no browser executes.
 * That is how RNF-05 (≤ 120 kB gzip of initial JS) and RNF-03 (LCP ≤ 2,0 s
 * on 4G) are met here: not by budgeting, but by there being nothing to
 * budget.
 */

/** RF-280: "estática com revalidação diária". */
export const revalidate = 86_400;

/**
 * Every published page, prerendered at build time.
 *
 * **This must not break a build with no database.** `next build` sets
 * `NODE_ENV=production`, and `getUnscopedDb()` deliberately throws when
 * `DATABASE_URL` is unset in production (a silent local database serving
 * production traffic would be far worse than a crash — see
 * `packages/db/src/client.ts`). Without the tolerance below, `pnpm build`
 * would stop working for every developer who has no Postgres, which is
 * every developer on this project by design: E0 exists so all domain work
 * can proceed with no external account.
 *
 * So a failure here warns and returns `[]`, and the warning names
 * `DATABASE_URL` and says exactly what was lost. Nothing else is lost:
 * `dynamicParams` defaults to `true`, so a page that was not prerendered
 * still renders on demand the first time it is requested, from a runtime
 * that does have a database. The build produces a smaller output, not a
 * broken site.
 *
 * The error is logged alongside the warning rather than swallowed, because
 * `container()` can also fail for a reason that is *not* `DATABASE_URL` —
 * it resolves `APP_BASE_URL` for RF-185's reminder mailer, and refuses to
 * guess that one in production too. A deploy that sets `DATABASE_URL` and
 * forgets `APP_BASE_URL` therefore takes this branch as well, and the
 * logged error is the only thing that tells the two apart.
 */
export async function generateStaticParams(): Promise<ChargeParams[]> {
  try {
    const { db } = container();
    return await loadPublishedChargeParams(db);
  } catch (error) {
    console.warn(
      "[pentefino] /cobranca/[issuer]/[charge]: could not read seo_pages, so no charge page was " +
        "prerendered (they still render on demand). This is normally DATABASE_URL being unset - " +
        "`next build` runs with NODE_ENV=production, where getUnscopedDb() refuses to fall back to " +
        "a local database.",
      error,
    );
    return [];
  }
}

export async function generateMetadata(
  { params }: { params: Promise<{ issuer: string; charge: string }> },
): Promise<Metadata> {
  const { issuer, charge } = await params;
  const { db } = container();
  const page = await loadChargePage(issuer, charge, db);

  // The page itself is about to call `notFound()` for exactly this case.
  // `robots` is what actually keeps a 404 out of an index - `robots.txt`
  // (E10 Task 5) asks politely, page metadata is enforcement.
  if (!page) return { title: copy.NOT_FOUND_MESSAGE, robots: { index: false, follow: false } };

  const description = metaDescription(page.content.intro);
  const url = canonicalUrl(page.issuerSlug, page.chargeSlug);

  return {
    title: page.title,
    description,
    alternates: { canonical: url },
    // No `images` key on purpose: E10 Task 6 adds `opengraph-image.tsx` in
    // this same folder, and Next's file-based metadata fills `og:image`
    // (plus its width, height and type) from it. Hand-rolling the tag here
    // would produce a second, competing `og:image` that no longer follows
    // the route when the image does.
    openGraph: {
      type: "article",
      siteName: copy.BRAND,
      locale: "pt_BR",
      url,
      title: page.title,
      description,
    },
  };
}

export default async function ChargePage(
  { params }: { params: Promise<{ issuer: string; charge: string }> },
) {
  const { issuer, charge } = await params;
  const { db } = container();

  const page = await loadChargePage(issuer, charge, db);
  if (!page) notFound();

  // RF-281. `null` below 50 invoices seen, and `null` is rendered as
  // nothing at all - not a zero, not "dados insuficientes" beside an empty
  // figure. The threshold lives in the loader (see `loadChargeAggregate`),
  // so this component has no way to render a number that did not clear it.
  const aggregate = await loadChargeAggregate(page.issuerId, page.chargeSlug, db);

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>{copy.EYEBROW}</p>
      <p className={styles.issuerBadge}>{page.issuerName}</p>

      <MarkedTitle title={page.title} />

      <p className={styles.lede}>{page.content.intro}</p>

      {aggregate && (
        <section className={styles.aggregate} aria-labelledby="dados-agregados">
          <h2 id="dados-agregados" className={styles.aggregateHeading}>{copy.AGGREGATE_HEADING}</h2>
          <div className={styles.aggregateRow}>
            <div className={styles.aggregateCard}>
              <p className={styles.aggregateLabel}>{copy.AGGREGATE_SEEN_LABEL}</p>
              <p className={styles.aggregateValue}>{copy.formatCount(aggregate.invoicesSeen)}</p>
            </div>
            <div className={styles.aggregateCard}>
              <p className={styles.aggregateLabel}>{copy.AGGREGATE_FLAGGED_LABEL}</p>
              <p className={styles.aggregateValue}>
                {copy.formatShare(aggregate.flagged, aggregate.invoicesSeen)}
              </p>
            </div>
          </div>
          <p className={styles.aggregateNote}>{copy.AGGREGATE_NOTE}</p>
        </section>
      )}

      <SeoSections sections={page.content.sections} />
      <SeoFaq faq={page.content.faq} />
      <SeoProvenance text={page.content.provenance} />

      <FaqJsonLd faq={page.content.faq} />
    </main>
  );
}

/**
 * The headline, with §13.1's hand-drawn accent used exactly once on this
 * page — under the clause that states what the page answers.
 *
 * Every title in the corpus is shaped `"<cobrança> na conta da <emissora>:
 * <a pergunta>"`, so the text after the last `": "` is "o que é essa
 * linha", "o que é esse pacote", "o que é essa seção" or "o que são". That
 * clause is the accent for two reasons. It is the promise a reader
 * recognises — the same question the front door asks with this same stroke
 * ("sua conta tem linhas que ninguém lê") — and it is *short*: nineteen
 * characters at most across the whole corpus, so it never wraps, even at
 * the smallest headline size on the narrowest phone. That matters
 * mechanically, not only visually: the underline is one absolutely
 * positioned SVG spanning its span's box, so a marked phrase that wrapped
 * would draw a single stroke across the full column under the last line.
 * Marking the subject instead ("Serviços de valor adicionado (SVA) na conta
 * da Vivo", thirty-four characters and more) is exactly the case that
 * breaks.
 *
 * A title with no `": "` is underlined whole rather than not at all: the
 * motif is the product's signature and must not quietly disappear because
 * an author wrote a heading differently. That branch can wrap, and its
 * imperfect stroke is the deliberate trade against losing the accent
 * entirely; no title in the corpus takes it.
 *
 * The SVG is `app/page.tsx`'s, path and all. `aria-hidden`, because it is
 * decoration: the heading's text is already the accessible name.
 */
function MarkedTitle({ title }: { title: string }) {
  const separator = ": ";
  const at = title.lastIndexOf(separator);
  const head = at === -1 ? "" : title.slice(0, at + separator.length);
  const marked = at === -1 ? title : title.slice(at + separator.length);

  return (
    <h1 className={styles.heading}>
      {head}
      <span className={styles.marked}>
        {marked}
        <svg
          className={styles.markedUnderline}
          viewBox="0 0 200 20"
          fill="none"
          aria-hidden="true"
          focusable="false"
          preserveAspectRatio="none"
        >
          <path
            d="M4 13c38-7 78-9 118-6 26 2 51 6 74 10"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
    </h1>
  );
}
