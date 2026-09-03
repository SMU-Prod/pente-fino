import type { InvoiceCanonical, InvoiceItem } from "../invoice/canonical.js";
import { normalizeDescription } from "../invoice/normalize.js";
import { pairInvoiceItems } from "./index.js";

export type ContestedItem = {
  /** `findings.id` — carried through so the caller can settle the row. */
  findingId: string;
  /** The contested line's description, as it appeared on invoice N. */
  description: string;
  /** The contested charge, in positive integer cents. */
  amountCents: number;
};

export type ContestedVerdict = "disappeared" | "reversed" | "still_charged";

export type ContestedResolution = {
  findingId: string;
  verdict: ContestedVerdict;
  /** Integer cents this verdict recovered. 0 for `still_charged`. */
  recoveredCents: number;
  /**
   * An English machine trace of why this verdict was reached (e.g.
   * `"no pair on 2026-08 invoice"`). This is NOT shown to a person — it
   * exists so a later reader can trace a `recoveredCents` figure back to
   * its cause — so it does NOT go through `lintUserFacingText`
   * (INV-004/INV-005 govern only copy a person actually sees). Do not put
   * this string on a screen.
   */
  evidence: string;
};

export type ContestedOutcome = {
  resolutions: ContestedResolution[];
  /** Sum of `recoveredCents`. Integer cents. */
  recoveredCents: number;
  /** True when every contested item is `disappeared` or `reversed`. */
  allSettled: boolean;
};

/** Flattens `sections[].items[]` into one list in document order. */
function flattenItems(invoice: InvoiceCanonical): InvoiceItem[] {
  return invoice.sections.flatMap((section) => section.items);
}

/**
 * Finds the previous-invoice line each contested item refers to, by
 * `normalizeDescription` (RF-201's "sem par na fatura seguinte" is judged
 * against the item the person actually contested on invoice N, not against
 * whatever ends up on N+1).
 *
 * Previous-invoice lines are grouped by normalised description in document
 * order, and each contested item consumes the earliest not-yet-consumed
 * line in its group — so duplicate contested items pointing at duplicate
 * lines pair up one-to-one, the same way `pairInvoiceItems`'s own exact
 * pass consumes duplicates.
 *
 * An item whose normalised description is empty is never added to a group.
 * `pairInvoiceItems` never treats two empty-normalised descriptions as the
 * same item (see its doc comment); mirroring that here means a contested
 * item that itself normalises to "" finds no group and falls straight into
 * the "no matching line" throw below, exactly like a genuinely-absent
 * description would — rather than silently matching some unrelated empty
 * line by coincidence of both being "".
 *
 * Throws when a contested item has no line left to claim: RF-201 assumes
 * the contested item came from *this* invoice's own findings, so a miss
 * here is a caller bug (the finding does not belong to `previous`, or its
 * description was mangled), not a fact about the invoices worth reporting
 * as `still_charged`.
 */
/** A contested item together with the specific previous-invoice line it was located on. */
type LocatedContestedItem = { contested: ContestedItem; previousItem: InvoiceItem };

function locatePreviousItems(
  previous: InvoiceCanonical,
  current: InvoiceCanonical,
  contested: ContestedItem[],
): LocatedContestedItem[] {
  const pools = new Map<string, InvoiceItem[]>();
  for (const item of flattenItems(previous)) {
    const key = normalizeDescription(item.description);
    if (key === "") continue;
    const pool = pools.get(key);
    if (pool) {
      pool.push(item);
    } else {
      pools.set(key, [item]);
    }
  }

  return contested.map((contestedItem) => {
    const key = normalizeDescription(contestedItem.description);
    const previousItem = pools.get(key)?.shift();
    if (!previousItem) {
      throw new Error(
        `contested item "${contestedItem.description}" has no matching line on the previous invoice ` +
          `(${previous.issuer.name}, period ${previous.period.start}..${previous.period.end}); ` +
          `current invoice is ${current.issuer.name}, period ${current.period.start}..${current.period.end}`,
      );
    }
    return { contested: contestedItem, previousItem };
  });
}

type CreditMatch = { credit: InvoiceItem; kind: "exact" | "double" };

/**
 * Assigns each contested item at most one credit line, per RF-201's
 * "estorno" rule: a credit (an item with `amountCents < 0`) reverses a
 * contested item when its absolute value equals the contested amount
 * (exact) or double it (double). Matching is by amount only — RF-201 says
 * nothing about the credit's description, and a real reversal line is
 * routinely worded nothing like the charge it reverses ("Crédito
 * referente a acordo").
 *
 * Each credit line settles at most one contested item. When several
 * contested items could claim the same credit, this resolves the
 * conflict deterministically in two passes: every exact-amount match is
 * assigned first (in `contested` input order), then every remaining
 * double-amount match (also in input order) — exact-amount matches
 * outrank double-amount ones regardless of which contested item comes
 * first in the input, and only after that does input order break ties
 * between contested items competing in the same class. Within either
 * pass, a contested item claims the earliest not-yet-consumed eligible
 * credit in current-invoice document order.
 */
function matchCredits(current: InvoiceCanonical, contested: ContestedItem[]): Map<number, CreditMatch> {
  const credits = flattenItems(current).filter((item) => item.amountCents < 0);
  const consumed = new Set<InvoiceItem>();
  const matches = new Map<number, CreditMatch>();

  contested.forEach((item, index) => {
    const credit = credits.find((c) => !consumed.has(c) && Math.abs(c.amountCents) === item.amountCents);
    if (credit) {
      consumed.add(credit);
      matches.set(index, { credit, kind: "exact" });
    }
  });

  contested.forEach((item, index) => {
    if (matches.has(index)) return;
    const credit = credits.find((c) => !consumed.has(c) && Math.abs(c.amountCents) === item.amountCents * 2);
    if (credit) {
      consumed.add(credit);
      matches.set(index, { credit, kind: "double" });
    }
  });

  return matches;
}

/**
 * RF-201: given invoice N (`previous`) and N+1 (`current`), decides — for
 * each item a person contested on N — whether that charge disappeared, was
 * reversed by a credit, or is still being charged.
 *
 * This is a pure classification boundary. It does not decide whether a
 * case closes on this evidence or reopens later (RF-202/RF-203) — those
 * are separate E6 concerns this function is not going to grow into.
 *
 * Order of evaluation, per contested item:
 * 1. **Reversal first.** A credit is positive evidence that money came
 *    back; the mere absence of a new charge is only the absence of
 *    evidence, so a credit outranks it (see `matchCredits`). This is
 *    checked regardless of whether the item also disappeared or is still
 *    paired — a reversal can coincide with either.
 * 2. **Disappearance.** No credit claimed the item, and it has no pair on
 *    `current` (`pairInvoiceItems`'s `disappeared` list).
 * 3. **Still charged.** No credit, and it paired with a `current` line —
 *    regardless of whether the amount changed. RF-201 defines only two
 *    positive verdicts; a partially reduced charge is still a charge.
 *
 * `recoveredCents`:
 * - Reversal: `Math.abs(credit.amountCents)`, the money actually credited
 *   (including when it is the doubled amount).
 * - Disappearance: `contested.amountCents`, one cycle's charge. Not more:
 *   a disappearance is evidence the *next* cycle stopped, not proof of how
 *   many cycles already happened — counting further back would credit
 *   money nobody has seen confirmed, inflating §1.4's north-star metric.
 * - Still charged: 0 — nothing was recovered.
 */
export function classifyContestedItems(input: {
  previous: InvoiceCanonical;
  current: InvoiceCanonical;
  contested: ContestedItem[];
}): ContestedOutcome {
  const { previous, current, contested } = input;

  const located = locatePreviousItems(previous, current, contested);
  const creditMatches = matchCredits(current, contested);

  const diff = pairInvoiceItems(previous, current);
  const currentByPreviousItem = new Map<InvoiceItem, InvoiceItem>();
  for (const pair of diff.paired) {
    currentByPreviousItem.set(pair.previous, pair.current);
  }
  const disappearedItems = new Set<InvoiceItem>(diff.disappeared);

  const resolutions: ContestedResolution[] = located.map(({ contested: item, previousItem }, index) => {
    const creditMatch = creditMatches.get(index);
    if (creditMatch) {
      const recoveredCents = Math.abs(creditMatch.credit.amountCents);
      const evidence =
        creditMatch.kind === "exact"
          ? `credit of ${creditMatch.credit.amountCents} matches contested ${item.amountCents}`
          : `credit of ${creditMatch.credit.amountCents} matches double of contested ${item.amountCents}`;
      return { findingId: item.findingId, verdict: "reversed", recoveredCents, evidence };
    }

    if (disappearedItems.has(previousItem)) {
      const currentMonth = current.period.start.slice(0, 7);
      return {
        findingId: item.findingId,
        verdict: "disappeared",
        recoveredCents: item.amountCents,
        evidence: `no pair on ${currentMonth} invoice`,
      };
    }

    // Not a reversal and not disappeared: `pairInvoiceItems` partitions
    // every non-empty-normalised previous item into exactly `paired` or
    // `disappeared`, and `locatePreviousItems` never hands back an
    // empty-normalised item (see its doc comment) — so `previousItem` is
    // guaranteed to be a key of `currentByPreviousItem` here. The
    // non-null assertion documents that guarantee instead of hiding a
    // structurally-unreachable branch behind a silent fallback.
    const currentItem = currentByPreviousItem.get(previousItem)!;
    return {
      findingId: item.findingId,
      verdict: "still_charged",
      recoveredCents: 0,
      evidence: `still charged as "${currentItem.description}" (${currentItem.amountCents})`,
    };
  });

  const recoveredCents = resolutions.reduce((sum, r) => sum + r.recoveredCents, 0);
  const allSettled = resolutions.every((r) => r.verdict !== "still_charged");

  return { resolutions, recoveredCents, allSettled };
}
