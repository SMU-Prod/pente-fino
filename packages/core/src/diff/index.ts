import type { InvoiceCanonical, InvoiceItem } from "../invoice/canonical.js";

export type PairedItem = { previous: InvoiceItem; current: InvoiceItem; score: number };

export type InvoiceDiff = {
  paired: PairedItem[];
  disappeared: InvoiceItem[];
  appeared: InvoiceItem[];
};

/**
 * Pairs items between invoice N and N+1 (RF-200).
 *
 * E0 ships the boundary. Exact match on the normalised description, then
 * trigram ≥ 0.8, then unpaired — that is E6.
 */
export function diffInvoices(previous: InvoiceCanonical, current: InvoiceCanonical): InvoiceDiff {
  void previous;
  void current;
  return { paired: [], disappeared: [], appeared: [] };
}
