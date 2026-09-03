import { and, eq } from "drizzle-orm";
import { containsPii, formatCentsBRL, type Category } from "@pentefino/core";
// eslint-disable-next-line pentefino/require-with-user -- RF-146's public page is the deliberate INV-008 exception: it is reached by an unguessable capability token (invoices.publicToken), never by session, exactly like RF-145's card (see apps/web/app/api/card/[token]/route.tsx's identical disable comment, which this file's loadPublicReport mirrors). This is the one unscoped read in this route and selects a narrow, fixed set of columns - never invoices.canonical, invoiceItems, userId, sessionId, fileKey, periodStart/periodEnd/dueDate, or a finding's own evidence - so this exception cannot widen into a general leak.
import { schema } from "@pentefino/db";
import type { Database } from "@pentefino/db";

const { findings, invoices, issuers } = schema;

/**
 * Everything the public page is allowed to know. Deliberately not "the
 * invoice row" or "the report response" passed straight through - see
 * `CardViewModel` in the card route for the identical reasoning: a type
 * this narrow is itself a control, since there is no field here a
 * canonical, a line item, a name, a document number, a period or a due
 * date could ever occupy.
 *
 * `INV-008`/RF-146: the issuer's name, the amount and the number of
 * findings are the point of sharing this page at all; anything that could
 * identify the person who received the bill is not, and is not
 * represented in this type. Concretely, beyond `INV-007`'s CPF/CNPJ/
 * address/barcode/digitable-line markers already applied before anything
 * is persisted:
 *
 *   - item descriptions and section names are excluded outright, not
 *     merely masked. `packages/core/src/invoice/mask.ts` documents its own
 *     honest limitation - a person's name, RG or phone number surviving
 *     free text is not caught - so free text pulled from an invoice's
 *     items is never safe to publish verbatim, no matter how it is
 *     labelled. This is the same reasoning RF-145's card already applies
 *     (it never touches `invoiceItems` either); this page follows it too.
 *   - the billing period and the due date are excluded as well, even
 *     though a date alone identifies no one: they add no information a
 *     stranger deciding whether to check their own bill needs, and every
 *     field this page carries is one more thing a future edit could widen
 *     by accident - the point of sharing is narrow on purpose.
 *   - the issuer's own display name is defense-in-depth, not structurally
 *     safe by type alone - see `safeIssuerLabel` below for the second gate
 *     that actually protects it.
 */
export type PublicReport = {
  suspectCents: number;
  doubledCents: number;
  findingsCount: number;
  issuerLabel: string;
};

// Standalone tags, not sentences - mirrors the card route's own
// CATEGORY_LABELS and the same reason: sidesteps Portuguese gender/
// preposition agreement ("da Vivo" vs "do Sabesp") a category-in-a-sentence
// template would need to get right for every current and future issuer.
const CATEGORY_LABELS: Record<Category, string> = {
  telecom: "Telecom",
  card: "Cartão",
  energy: "Energia",
  water: "Água",
};

/**
 * The second of this page's two gates (the first is `loadPublicReport`'s
 * `WHERE` clause below): even though `issuers.displayName` is, as this
 * codebase's issuer detection is written today, always either a curated
 * seed value or the fixed literal "Emissor não identificado" - never free
 * text derived from a document's OCR content - this check does not trust
 * that invariant alone. It mirrors `safeIssuerLabel` in
 * `apps/web/app/api/card/[token]/route.tsx` verbatim, on purpose: the two
 * public surfaces answer the identical question, and a future change to
 * one that is not made to the other is exactly the kind of drift this
 * comment (and its twin there) exists to make a reviewer notice. Same
 * honest limit as documented there: `containsPii` validates CPF/CNPJ by
 * check digit and recognises addresses and document lines, but does not
 * detect a person's name or a phone number on its own - real safety rests
 * on `displayName`'s provenance staying closed-set.
 */
function safeIssuerLabel(displayName: string | null, category: Category | null): string {
  if (displayName && !containsPii(displayName)) return displayName;
  if (category) return CATEGORY_LABELS[category];
  return "Fatura";
}

/**
 * The public page's one unscoped read (INV-008's deliberate exception, see
 * the disable comment on the `schema` import above). Two gates sit in the
 * `WHERE` clause of the first query, not checked afterwards in application
 * code, so there is no path that loads the row before deciding whether the
 * caller may see it - identical reasoning to `loadCardData` in the card
 * route, which answers the same access-control question for the same
 * column:
 *
 *   - `publicToken` must match exactly - `NULL` (never minted yet, or
 *     revoked per RF-146's "revogável") cannot equal any token string, so
 *     a revoked or not-yet-existing token 404s indistinguishably from a
 *     wrong one.
 *   - `status = 'analyzed'` - a queued, still-extracting or failed invoice
 *     has no findings worth sharing yet, and a `needs_review` invoice has
 *     no honest total to show (RF-144's principle applies here too).
 *
 * Selects only `invoices.id` (to join `findings` by) plus the issuer's
 * category and display name - never `canonical`, `invoiceItems`, `userId`,
 * `sessionId`, `fileKey`, `periodStart`/`periodEnd`/`dueDate`, or a
 * finding's own `evidence` sentence. The findings aggregate excludes
 * `shadow` rows the same way `withUser().findingsForInvoice` does for the
 * authenticated report, so a rule still on probation cannot inflate a
 * number that ends up posted publicly either.
 */
export async function loadPublicReport(token: string, db: Database): Promise<PublicReport | null> {
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
