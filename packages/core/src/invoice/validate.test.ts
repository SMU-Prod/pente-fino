import { describe, expect, it } from "vitest";
import type { InvoiceCanonical } from "./canonical.js";
import { validateInvoice } from "./validate.js";

function invoice(over: Partial<InvoiceCanonical> = {}): InvoiceCanonical {
  return {
    issuer: { name: "Claro Móvel", category: "telecom" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 10000,
    sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
    extraction: { confidence: 0.9, warnings: [] },
    ...over,
  } as InvoiceCanonical;
}

describe("validateInvoice", () => {
  it("passes a coherent invoice", () => {
    expect(validateInvoice(invoice()).ok).toBe(true);
  });

  it("accepts a sum within 1% of the total", () => {
    const v = invoice({
      sections: [{ name: "S", items: [{ description: "Plano", amountCents: 9950 }] }],
    });
    expect(validateInvoice(v).ok).toBe(true);
  });

  it("fails when the items do not sum to the total", () => {
    const v = invoice({
      sections: [{ name: "S", items: [{ description: "Plano", amountCents: 5000 }] }],
    });
    const result = validateInvoice(v);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.check)).toContain("total_mismatch");
  });

  it("fails when the period ends before it starts", () => {
    const v = invoice({ period: { start: "2026-07-31", end: "2026-07-01" } });
    expect(validateInvoice(v).failures.map((f) => f.check)).toContain("period_inverted");
  });

  it("fails when the due date precedes the end of the period", () => {
    const v = invoice({ dueDate: "2026-07-15" });
    expect(validateInvoice(v).failures.map((f) => f.check)).toContain("due_before_period_end");
  });

  it("accepts a due date equal to the end of the period", () => {
    const v = invoice({ dueDate: "2026-07-31" });
    expect(validateInvoice(v).ok).toBe(true);
  });

  it("fails when one item is more than 50x the median", () => {
    const items = [
      { description: "A", amountCents: 100 },
      { description: "B", amountCents: 100 },
      { description: "C", amountCents: 100 },
      { description: "D", amountCents: 9700 },
    ];
    const v = invoice({ sections: [{ name: "S", items }] });
    expect(validateInvoice(v).failures.map((f) => f.check)).toContain("item_outlier");
  });

  it("does not flag an outlier when there is a single item", () => {
    expect(validateInvoice(invoice()).failures).toHaveLength(0);
  });

  it("reports every failure at once, not just the first", () => {
    const v = invoice({
      period: { start: "2026-07-31", end: "2026-07-01" },
      dueDate: "2026-06-01",
    });
    expect(validateInvoice(v).failures.length).toBeGreaterThanOrEqual(2);
  });

  it("uses the absolute value for the median, so credits do not skew it", () => {
    const items = [
      { description: "A", amountCents: -100 },
      { description: "B", amountCents: 100 },
      { description: "C", amountCents: 100 },
    ];
    const v = invoice({ totalCents: 100, sections: [{ name: "S", items }] });
    expect(validateInvoice(v).failures.map((f) => f.check)).not.toContain("item_outlier");
  });

  it("computes the median as the middle value for an odd number of items", () => {
    // sorted magnitudes [10, 20, 9000]; median is the middle value, 20 — not an
    // average of any pair. Threshold = 50 * 20 = 1000; 9000 exceeds it.
    const items = [
      { description: "A", amountCents: 10 },
      { description: "B", amountCents: 20 },
      { description: "C", amountCents: 9000 },
    ];
    const v = invoice({ totalCents: 9030, sections: [{ name: "S", items }] });
    expect(validateInvoice(v).failures.map((f) => f.check)).toContain("item_outlier");
  });

  it("computes the median as the average of the two middle values for an even number of items", () => {
    // sorted magnitudes [50, 100, 200, 8000]; median = (100 + 200) / 2 = 150, so the
    // threshold is 50 * 150 = 7500 and 8000 is an outlier. Taking either middle value
    // alone instead of averaging them would give a different verdict here: using 200
    // alone gives a threshold of 10000, under which 8000 would NOT be flagged. This
    // test pins the average, not either single middle value.
    const items = [
      { description: "A", amountCents: 50 },
      { description: "B", amountCents: 100 },
      { description: "C", amountCents: 200 },
      { description: "D", amountCents: 8000 },
    ];
    const v = invoice({ totalCents: 8350, sections: [{ name: "S", items }] });
    expect(validateInvoice(v).failures.map((f) => f.check)).toContain("item_outlier");
  });

  it("skips the outlier check when the median magnitude is zero (at least half the items are zero-valued)", () => {
    const items = [
      { description: "A", amountCents: 0 },
      { description: "B", amountCents: 0 },
      { description: "C", amountCents: 0 },
      { description: "D", amountCents: 999999 },
    ];
    const v = invoice({ totalCents: 999999, sections: [{ name: "S", items }] });
    expect(validateInvoice(v).failures.map((f) => f.check)).not.toContain("item_outlier");
  });

  it("KNOWN LIMITATION: a two-item invoice can never trip item_outlier, no matter how extreme the disparity", () => {
    // For two items x <= y, median = (x + y) / 2, and y > 50 * median has no solution
    // for non-negative x, y other than x = y = 0. This is structural, not tunable.
    const items = [
      { description: "A", amountCents: 1 },
      { description: "B", amountCents: 999999999 },
    ];
    const v = invoice({ totalCents: 1000000000, sections: [{ name: "S", items }] });
    expect(validateInvoice(v).failures.map((f) => f.check)).not.toContain("item_outlier");
  });

  it("KNOWN LIMITATION: an all-credit invoice always fails total_mismatch, because totalCents cannot be negative", () => {
    // InvoiceCanonical.totalCents is nonnegative (PRD §7.1), so an invoice whose true
    // total is negative (all items are credits) has no way to express that total.
    // The closest representable totalCents is 0, which the item sum (-5000) can never
    // be within tolerance of. This pins current behavior — a gap in the canonical
    // schema (E1), not something to "fix" in validateInvoice.
    const items = [
      { description: "Credit A", amountCents: -3000 },
      { description: "Credit B", amountCents: -2000 },
    ];
    const v = invoice({ totalCents: 0, sections: [{ name: "S", items }] });
    const result = validateInvoice(v);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.check)).toContain("total_mismatch");
  });

  it("KNOWN LIMITATION: with two outliers among few items, the median shifts enough that neither is caught", () => {
    // median([100, 100, 9000, 9500]) = 4550, threshold = 227500 — well above both
    // 9000 and 9500. A property of the median as RF-108 specifies it.
    const items = [
      { description: "A", amountCents: 100 },
      { description: "B", amountCents: 100 },
      { description: "C", amountCents: 9000 },
      { description: "D", amountCents: 9500 },
    ];
    const v = invoice({ totalCents: 18700, sections: [{ name: "S", items }] });
    expect(validateInvoice(v).failures.map((f) => f.check)).not.toContain("item_outlier");
  });
});
