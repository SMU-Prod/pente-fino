import type { InvoiceCanonical, InvoiceItem } from "../invoice/canonical.js";
import { normalizeDescription } from "../invoice/normalize.js";
import { TRIGRAM_THRESHOLD, trigramSimilarity } from "./trigram.js";

export type PairedItem = { previous: InvoiceItem; current: InvoiceItem; score: number };

export type InvoiceDiff = {
  paired: PairedItem[];
  disappeared: InvoiceItem[];
  appeared: InvoiceItem[];
};

/** An item together with its document order index and normalised description. */
type IndexedItem = { item: InvoiceItem; index: number; normalized: string };

/**
 * Flattens `sections[].items[]` into one list in document order (section
 * order, then item order within the section), each tagged with that order
 * and its normalised description computed once.
 */
function indexItems(invoice: InvoiceCanonical): IndexedItem[] {
  return invoice.sections
    .flatMap((section) => section.items)
    .map((item, index) => ({ item, index, normalized: normalizeDescription(item.description) }));
}

type Candidate = { previous: IndexedItem; current: IndexedItem; score: number };

/**
 * Pairs items between invoice N and N+1 by description (RF-200): exact
 * match on the normalised description, then trigram >= TRIGRAM_THRESHOLD,
 * then unpaired.
 *
 * This boundary covers item pairing only — nothing more. RF-201's reversal
 * detection, RF-202's conservative resolution and RF-204's `recoveredCents`
 * all need the contested findings and the case's protocol history, which
 * two invoices alone cannot supply. Determining a case outcome from a diff
 * is a separate E6 concern that this function is not going to grow into;
 * do not build against it expecting that.
 *
 * Algorithm, in order:
 * 1. Flatten both invoices' items into document order and normalise each
 *    description once (`indexItems`).
 * 2. Exact pass: for each previous item, in document order, take the
 *    earliest not-yet-paired current item with an equal normalised
 *    description. This is what makes duplicates pair one-to-one in
 *    document order instead of many-to-one: three identical lines on N
 *    and two on N+1 produce two pairs and one leftover on the previous
 *    side. These pairs score 1.
 * 3. Trigram pass: over the items still unpaired on both sides, score
 *    every remaining previous x current combination with
 *    `trigramSimilarity`, keep only scores >= TRIGRAM_THRESHOLD, and
 *    consume them greedily, highest score first. Ties (equal score) are
 *    broken deterministically by previous-side index, then current-side
 *    index — never by object/array iteration order — so the result (and
 *    everything computed from it downstream, including `recoveredCents`)
 *    is reproducible across runs on the same input.
 * 4. Whatever remains unpaired: previous-side leftovers are `disappeared`,
 *    current-side leftovers are `appeared`.
 *
 * `paired` is ordered by previous-side document order.
 */
export function pairInvoiceItems(previous: InvoiceCanonical, current: InvoiceCanonical): InvoiceDiff {
  const previousItems = indexItems(previous);
  const currentItems = indexItems(current);

  const pairedPrevious = new Set<number>();
  const pairedCurrent = new Set<number>();
  const pairs: Candidate[] = [];

  // Exact pass.
  for (const prev of previousItems) {
    const match = currentItems.find(
      (cur) => !pairedCurrent.has(cur.index) && cur.normalized === prev.normalized,
    );
    if (match) {
      pairs.push({ previous: prev, current: match, score: 1 });
      pairedPrevious.add(prev.index);
      pairedCurrent.add(match.index);
    }
  }

  // Trigram pass: gather every candidate pair scoring >= TRIGRAM_THRESHOLD
  // among the items the exact pass left unpaired.
  const candidates: Candidate[] = [];
  for (const prev of previousItems) {
    if (pairedPrevious.has(prev.index)) continue;
    for (const cur of currentItems) {
      if (pairedCurrent.has(cur.index)) continue;
      const score = trigramSimilarity(prev.normalized, cur.normalized);
      if (score >= TRIGRAM_THRESHOLD) {
        candidates.push({ previous: prev, current: cur, score });
      }
    }
  }

  // Highest score first; ties broken by previous-side index, then
  // current-side index (see algorithm step 3 above).
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.previous.index !== b.previous.index) return a.previous.index - b.previous.index;
    return a.current.index - b.current.index;
  });

  for (const candidate of candidates) {
    if (pairedPrevious.has(candidate.previous.index)) continue;
    if (pairedCurrent.has(candidate.current.index)) continue;
    pairs.push(candidate);
    pairedPrevious.add(candidate.previous.index);
    pairedCurrent.add(candidate.current.index);
  }

  pairs.sort((a, b) => a.previous.index - b.previous.index);

  const paired: PairedItem[] = pairs.map((pair) => ({
    previous: pair.previous.item,
    current: pair.current.item,
    score: pair.score,
  }));
  const disappeared = previousItems.filter((p) => !pairedPrevious.has(p.index)).map((p) => p.item);
  const appeared = currentItems.filter((c) => !pairedCurrent.has(c.index)).map((c) => c.item);

  return { paired, disappeared, appeared };
}
