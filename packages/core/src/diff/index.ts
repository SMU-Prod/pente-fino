import type { InvoiceCanonical, InvoiceItem } from "../invoice/canonical.js";

export type PairedItem = { previous: InvoiceItem; current: InvoiceItem; score: number };

export type InvoiceDiff = {
  paired: PairedItem[];
  disappeared: InvoiceItem[];
  appeared: InvoiceItem[];
};

function describeInvoice(invoice: InvoiceCanonical): string {
  const itemCount = invoice.sections.reduce((total, section) => total + section.items.length, 0);
  return `${invoice.issuer.name}@${invoice.period.start}..${invoice.period.end} (${itemCount} items)`;
}

/**
 * Pairs items between invoice N and N+1 by description (RF-200): exact
 * match on the normalised description, then trigram ≥ 0.8, then unpaired.
 *
 * This boundary covers item pairing only — nothing more. RF-201's reversal
 * detection, RF-202's conservative resolution and RF-204's `recoveredCents`
 * all need the contested findings and the case's protocol history, which
 * two invoices alone cannot supply. Determining a case outcome from a diff
 * is a separate E6 concern that this function is not going to grow into;
 * do not build against it expecting that.
 *
 * E0 ships the boundary only, and it fails loudly rather than quietly:
 * `InvoiceCanonical` requires every invoice to have at least one section
 * with at least one item, so there is no genuinely empty pair this
 * function can ever be called with — every call throws until E6
 * implements the pairing.
 */
export function pairInvoiceItems(previous: InvoiceCanonical, current: InvoiceCanonical): InvoiceDiff {
  throw new Error(
    `item pairing is not implemented yet (E6): previous=[${describeInvoice(previous)}] current=[${describeInvoice(current)}]`,
  );
}
