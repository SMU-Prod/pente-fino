import { ImageResponse } from "next/og";
import { and, eq } from "drizzle-orm";
import React from "react";
import { containsPii, type Category } from "@pentefino/core";
import type { Database } from "@pentefino/db";
// eslint-disable-next-line pentefino/require-with-user -- RF-145's card is a deliberate public exception (PRD §8.2: "público por token"): it is reached by an unguessable capability token (invoices.publicToken), never by session, so withUser's session-ownership filter does not apply. loadCardData below is the one place that runs unscoped, and it selects a narrow, fixed set of columns - never invoices.canonical, invoiceItems, userId, sessionId or fileKey - so this exception cannot widen into a general leak.
import { schema } from "@pentefino/db";
import { TOKENS } from "@pentefino/ui";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";

const { findings, invoices, issuers } = schema;

const WIDTH = 1200;
const HEIGHT = 630;

/**
 * Everything the card is allowed to draw. Deliberately not "the invoice
 * row" or "the report response" passed straight through: a type this narrow
 * is itself a control - there is no field here a canonical, a line item, a
 * name or a document number could ever occupy, so a future edit cannot
 * accidentally widen what reaches `ImageResponse` by spreading a bigger
 * object into a prop. See `loadCardData` for where each field comes from.
 */
type CardViewModel = {
  suspectCents: number;
  doubledCents: number;
  findingsCount: number;
  issuerLabel: string;
};

// Standalone tags, not sentences - deliberately sidesteps Portuguese
// gender/preposition agreement ("da Vivo" vs "do Sabesp") that a
// category-in-a-sentence template would need to get right for every
// current and future issuer.
const CATEGORY_LABELS: Record<Category, string> = {
  telecom: "Telecom",
  card: "Cartão",
  energy: "Energia",
  water: "Água",
};

/**
 * Defense in depth, not the primary guarantee. `issuers.displayName` is, as
 * this codebase's issuer detection is written today (`detectIssuer` +
 * `apps/jobs/src/tasks/ingest.ts`), always either a curated seed value or
 * the fixed literal "Emissor não identificado" - never free text derived
 * from a document's OCR content - which is the actual reason this field is
 * safe to render at all. `containsPii` is layered on top in case that
 * invariant is ever violated (a data-entry mistake in the seed file, a
 * future admin tool that edits it by hand), but it is a second, not a
 * sufficient, defense: it validates CPF/CNPJ by check digit and recognises
 * addresses and document lines, but - by this repository's own accepted E0
 * limitation (see packages/core/src/invoice/mask.ts) - it does not detect a
 * person's name or a phone number. A `displayName` corrupted to *just* a
 * phone number would pass this check unnoticed. Real safety rests on the
 * field's provenance staying closed-set; this line only catches the shapes
 * `containsPii` already knows.
 */
function safeIssuerLabel(displayName: string | null, category: Category | null): string {
  if (displayName && !containsPii(displayName)) return displayName;
  if (category) return CATEGORY_LABELS[category];
  return "Fatura";
}

/**
 * Plain-cents BRL formatting, deliberately not `Intl.NumberFormat` - see the
 * identical comment on the report route's own copy of this function
 * (apps/web/app/api/invoices/[id]/report/route.ts): pt-BR's ICU output uses
 * a non-breaking space after "R$" that PRD §10's own acceptance text does
 * not.
 */
function formatCentsBRL(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const centavos = String(abs % 100).padStart(2, "0");
  return `${sign}R$ ${reais},${centavos}`;
}

function findingsLine(count: number): string {
  return count === 1 ? "1 cobrança para revisar" : `${count} cobranças para revisar`;
}

/**
 * The card's entire user-facing vocabulary, in one place so a test can lint
 * every string RF-145 can ever render, including the ones that only appear
 * when `doubledCents` is nonzero. §14.2's phrasing, not a paraphrase of it:
 * "para você verificar" (never "de cobrança ilegal"), "a norma prevê
 * devolução em dobro" (never "você tem direito a receber").
 */
type CardCopy = {
  brand: string;
  issuerLabel: string;
  headline: string;
  doubledLine: string | null;
  findingsLine: string;
};

function buildCardCopy(data: CardViewModel): CardCopy {
  return {
    brand: "Pente-fino",
    issuerLabel: data.issuerLabel,
    headline: `Encontramos ${formatCentsBRL(data.suspectCents)} para você verificar`,
    doubledLine: data.doubledCents > 0 ? "A norma prevê devolução em dobro" : null,
    findingsLine: findingsLine(data.findingsCount),
  };
}

/**
 * Built with `React.createElement` rather than JSX syntax, even though the
 * file is `.tsx`: satori (the renderer behind `next/og`'s `ImageResponse`)
 * only needs a plain React element tree, and spelling it out this way keeps
 * the tree's shape (exactly which strings sit in which props) unambiguous
 * to a reader and to the payload test below, with no JSX-transform
 * configuration to depend on.
 *
 * Colors are §13.1's light-theme tokens (`packages/ui`) - a shared PNG has
 * no viewer-local theme to react to, so there is no dark variant to pick
 * between. Fonts are satori's own default: no font file for Fraunces or IBM
 * Plex ships in this repository yet (`apps/web/public` has none), and
 * satori requires an actual font buffer to render anything other than its
 * built-in fallback - embedding the real typeface is left for whoever adds
 * those assets.
 */
function buildCardTree(copy: CardCopy): React.ReactElement {
  const t = TOKENS.light;
  const row = (children: React.ReactNode, style: React.CSSProperties = {}) =>
    React.createElement("div", {
      style: { display: "flex", flexDirection: "row", ...style },
    }, children);
  const col = (children: React.ReactNode, style: React.CSSProperties = {}) =>
    React.createElement("div", {
      style: { display: "flex", flexDirection: "column", ...style },
    }, children);

  return col(
    [
      row(
        [
          React.createElement("div", {
            key: "brand", style: { display: "flex", fontSize: 30, fontWeight: 700, color: t.ink3 },
          }, copy.brand),
          React.createElement("div", {
            key: "issuer",
            style: {
              display: "flex", fontSize: 24, fontWeight: 600, color: t.deep,
              backgroundColor: t.markSoft, padding: "10px 24px", borderRadius: 999,
            },
          }, copy.issuerLabel),
        ],
        { justifyContent: "space-between", alignItems: "center" },
      ),
      col(
        [
          React.createElement("div", {
            key: "headline", style: { display: "flex", fontSize: 60, fontWeight: 700, color: t.mark, lineHeight: 1.2 },
          }, copy.headline),
          copy.doubledLine
            ? React.createElement("div", {
              key: "doubled", style: { display: "flex", fontSize: 30, color: t.ok, marginTop: 20 },
            }, copy.doubledLine)
            : null,
        ],
        {},
      ),
      React.createElement("div", {
        key: "findings", style: { display: "flex", fontSize: 26, color: t.ink2 },
      }, copy.findingsLine),
    ],
    {
      width: "100%", height: "100%", justifyContent: "space-between", padding: 64,
      backgroundColor: t.paper, color: t.ink, fontFamily: "sans-serif",
    },
  );
}

/**
 * The one unscoped read in this route (see the disable comment on the
 * `schema` import above). Two gates, both in the `WHERE` clause of the
 * first query rather than checked afterwards in application code, so there
 * is no code path that loads the row before deciding whether the caller may
 * see it:
 *
 *   - `publicToken` must match exactly - `NULL` (never revoked, or revoked
 *     per RF-146's "revogável") cannot equal any token string, so a
 *     revoked or not-yet-existing token behaves identically to a wrong one.
 *   - `status = 'analyzed'` - a queued, still-extracting or failed invoice
 *     has no findings worth sharing yet, and a `needs_review` invoice has
 *     no honest total to show (RF-144's principle applies here too).
 *
 * Selects only `invoices.id` (to join `findings` by) plus the issuer's
 * category and display name - never `canonical`, `invoiceItems`,
 * `userId`, `sessionId` or `fileKey`. The findings aggregate excludes
 * `shadow` rows the same way `withUser().findingsForInvoice` does for the
 * authenticated report, so a rule still on probation cannot inflate a
 * number that ends up posted publicly either.
 */
async function loadCardData(token: string, db: Database): Promise<CardViewModel | null> {
  const [row] = await db
    .select({
      invoiceId: invoices.id,
      issuerCategory: issuers.category,
      issuerDisplayName: issuers.displayName,
    })
    .from(invoices)
    .leftJoin(issuers, eq(invoices.issuerId, issuers.id))
    .where(and(eq(invoices.publicToken, token), eq(invoices.status, "analyzed")));
  if (!row) return null;

  const findingRows = await db
    .select({ amountCents: findings.amountCents, doubledCents: findings.doubledCents })
    .from(findings)
    .where(and(eq(findings.invoiceId, row.invoiceId), eq(findings.shadow, false)));

  const suspectCents = findingRows.reduce((acc, f) => acc + f.amountCents, 0);
  const doubledCents = findingRows.reduce((acc, f) => acc + (f.doubledCents ?? 0), 0);

  return {
    suspectCents,
    doubledCents,
    findingsCount: findingRows.length,
    issuerLabel: safeIssuerLabel(row.issuerDisplayName, row.issuerCategory),
  };
}

export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { db } = container();

  const data = await loadCardData(token, db);
  if (!data) return apiError("not_found");

  const tree = buildCardTree(buildCardCopy(data));
  return new ImageResponse(tree, {
    width: WIDTH,
    height: HEIGHT,
    // `next/og` defaults to `public, immutable, no-transform, max-age=31536000`.
    // For a card minted from a real person's invoice that default is wrong in
    // the one direction that matters: RF-146 makes the token revocable, and a
    // year of immutable CDN caching means revoking it stops new fetches while
    // every cache that already has the image keeps serving it — so revocation
    // works everywhere except where the image actually went.
    //
    // Five minutes keeps the benefit that matters (a card is shared, and
    // fetched by every platform that unfurls the link, in its first minutes)
    // and bounds how long a revoked card survives. `stale-while-revalidate`
    // covers the burst without extending that bound, since a revalidation
    // against a revoked token returns the 404 the person asked for.
    headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
  });
}
