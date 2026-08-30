import type { InvoiceCanonical } from "./canonical.js";

export type ValidationFailure = {
  check: "total_mismatch" | "period_inverted" | "due_before_period_end" | "item_outlier";
  detail: string;
};

export type ValidationResult = { ok: boolean; failures: ValidationFailure[] };

const TOTAL_TOLERANCE = 0.01;
const OUTLIER_FACTOR = 50;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * The four deterministic post-extraction checks of RF-108.
 *
 * Known limitations (these are properties of RF-108 as specified — "dentro de 1%
 * do total", the median, a nonnegative `totalCents` — not bugs in this function):
 *
 * - **All-credit invoices cannot pass `total_mismatch`.** `InvoiceCanonical.totalCents`
 *   is `z.number().int().nonnegative()` (PRD §7.1), so an invoice whose items are all
 *   credits has no way to carry its true (negative) total. The item sum will always
 *   diverge from the nonnegative `totalCents` by more than the tolerance, so the
 *   invoice is routed to `needs_review` every time. If this needs fixing, the fix
 *   belongs in the canonical schema (E1), not in this check.
 *
 * - **The outlier check can never fire with exactly two items.** For two items
 *   `x, y >= 0`, `median = (x + y) / 2`, and `y > 50 * median` simplifies to
 *   `-24y > 25x`, which has no solution when `x, y >= 0` other than `x = y = 0`.
 *   A two-line invoice with one wildly disproportionate line is structurally
 *   undetectable by this check — a direct consequence of RF-108 naming the median
 *   as the reference statistic.
 *
 * - **The outlier check is skipped entirely when the median magnitude is zero**
 *   (i.e. at least half the items have `amountCents === 0`). This guards against a
 *   meaningless comparison (any nonzero item would "exceed" a zero threshold), but
 *   it also means a single large item sitting beside several zero-valued lines is
 *   never flagged.
 *
 * - **With few items and more than one outlier, the median itself shifts enough
 *   that neither is caught.** E.g. `[100, 100, 9000, 9500]`: median = 4550, so the
 *   threshold is 227500 — neither 9000 nor 9500 exceeds it, so no `item_outlier`
 *   failure is raised. This is a property of the median as RF-108 specifies it.
 */
export function validateInvoice(invoice: InvoiceCanonical): ValidationResult {
  const failures: ValidationFailure[] = [];
  const items = invoice.sections.flatMap((s) => s.items);

  const sum = items.reduce((acc, item) => acc + item.amountCents, 0);
  // RF-108 only requires the sum to be "dentro de 1% do total". The `Math.max(..., 1)`
  // floor is not part of that spec — it exists so a zero (or near-zero) `totalCents`
  // doesn't collapse the tolerance to zero-width, which would fail total_mismatch on
  // any item at all, even a rounding artifact. The floor only changes the outcome
  // below a total of 100 cents (R$ 1.00, where 1% is worth less than a cent), which
  // is not a realistic invoice — so its cost is theoretical, not something that
  // masks real mismatches in practice.
  const allowed = Math.max(Math.abs(invoice.totalCents) * TOTAL_TOLERANCE, 1);
  if (Math.abs(sum - invoice.totalCents) > allowed) {
    failures.push({
      check: "total_mismatch",
      detail: `items sum to ${sum} but the invoice total is ${invoice.totalCents}`,
    });
  }

  if (invoice.period.end <= invoice.period.start) {
    failures.push({
      check: "period_inverted",
      detail: `period ${invoice.period.start}..${invoice.period.end}`,
    });
  }

  if (invoice.dueDate < invoice.period.end) {
    failures.push({
      check: "due_before_period_end",
      detail: `due ${invoice.dueDate} precedes period end ${invoice.period.end}`,
    });
  }

  if (items.length > 1) {
    const magnitudes = items.map((item) => Math.abs(item.amountCents));
    const ref = median(magnitudes);
    // A zero median (at least half the items are zero-valued) makes the ratio
    // meaningless — see the "skipped entirely" limitation in the JSDoc above.
    if (ref > 0) {
      for (const [index, magnitude] of magnitudes.entries()) {
        if (magnitude > ref * OUTLIER_FACTOR) {
          failures.push({
            check: "item_outlier",
            detail: `item ${index} at ${magnitude} exceeds ${OUTLIER_FACTOR}x the median ${ref}`,
          });
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}
