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

/** The four deterministic post-extraction checks of RF-108. */
export function validateInvoice(invoice: InvoiceCanonical): ValidationResult {
  const failures: ValidationFailure[] = [];
  const items = invoice.sections.flatMap((s) => s.items);

  const sum = items.reduce((acc, item) => acc + item.amountCents, 0);
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
