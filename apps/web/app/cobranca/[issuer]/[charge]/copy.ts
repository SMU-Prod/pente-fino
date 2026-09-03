/**
 * Every pt-BR string RF-280's public `/cobranca/[issuer]/[charge]` page
 * introduces of its own, in one place — the same shape
 * `app/l/[token]/copy.ts` uses, and for the same reason: this is a surface
 * a stranger reads before they have any other reason to trust this product,
 * so §14.3's lint has to be able to reach every word of it at once
 * (`test/cobranca/page.test.ts` runs `lintUserFacingText` over each export
 * and over the rendered page).
 *
 * The page's *content* — the intro, the sections, the FAQ, the provenance
 * paragraph — is not here: it comes out of `seo_pages`, is authored in
 * `packages/db/src/seeds/seo-pages.content.ts`, and is already linted by
 * `packages/db/test/invariants/seo-content.spec.ts`. What lives here is the
 * frame the route itself puts around that content, which nothing else
 * lints.
 *
 * Code and comments are English; every exported value is the pt-BR text a
 * person actually reads.
 */

export const BRAND = "Pente-fino";

/** §13.1's mono uppercase eyebrow — uppercased by CSS, not by the string. */
export const EYEBROW = "Cobrança na fatura";

// --- RF-281's aggregate block ------------------------------------------
//
// Rendered only once `loadChargeAggregate` has cleared the ≥ 50 floor, so
// none of these strings can ever appear beside an empty or provisional
// figure. There is deliberately no "ainda não temos dados" variant: RF-281
// says the block does not render below the threshold, and a written
// placeholder in its place would be a claim of its own ("we are counting
// this") on a page whose job is to describe a kind of line, not to report
// on the reader's own bill.

export const AGGREGATE_HEADING = "O que as faturas enviadas mostram";
export const AGGREGATE_SEEN_LABEL = "Faturas com este item";
export const AGGREGATE_FLAGGED_LABEL = "Marcadas para conferir";

/**
 * Says the window out loud. `loadChargeAggregate` sums every stored period
 * rather than a trailing window (see its own note for why), so the number
 * is cumulative — and a cumulative number presented without saying so reads
 * as "this month", which it is not.
 */
export const AGGREGATE_NOTE =
  "Contagem de todas as faturas já enviadas ao Pente-fino, somando todos os períodos. " +
  "Descreve o que apareceu nas faturas que passaram por aqui, e não a conta de ninguém em particular.";

// --- the 404 -------------------------------------------------------------

/**
 * Shown by `not-found.tsx` for an unknown issuer, an unknown charge and a
 * page still in `draft` alike — the three are indistinguishable from
 * outside, the same way `/l/[token]`'s own `NOT_FOUND_MESSAGE` refuses to
 * say whether a token never existed or was revoked.
 */
export const NOT_FOUND_MESSAGE = "Não temos uma página sobre essa cobrança.";
export const BACK_HOME = "Voltar para o início";

// --- formatting ----------------------------------------------------------

/**
 * A whole number with pt-BR thousands separators ("1.284").
 *
 * Deliberately not `Intl.NumberFormat`, for the same reason
 * `formatCentsBRL` is not (see its copies in `lib/report.ts`,
 * `app/l/[token]/data.ts` and the card route): ICU's pt-BR output is not
 * byte-identical to what this product's own copy uses, and a page that is
 * prerendered at build time must not depend on which ICU data the build
 * machine happens to ship.
 */
export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * The flagged share, as a whole percentage ("22%").
 *
 * Rounded to the unit: the underlying counts are observations, not
 * measurements, and a decimal place would suggest a precision the sample
 * does not have. `total` is never zero at any call site (the block only
 * renders at `invoicesSeen ≥ 50`), and the guard is here anyway so this
 * function cannot produce "NaN%" if it is ever called from somewhere else.
 */
export function formatShare(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}
