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
});
