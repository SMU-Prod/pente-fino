import { describe, expect, it } from "vitest";
import { pairInvoiceItems } from "./index.js";
import type { InvoiceCanonical } from "../invoice/canonical.js";

const invoice = {
  issuer: { name: "Claro Móvel", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
  extraction: { confidence: 0.9, warnings: [] },
} as InvoiceCanonical;

const other = {
  ...invoice,
  period: { start: "2026-08-01", end: "2026-08-31" },
  dueDate: "2026-09-10",
} as InvoiceCanonical;

describe("pairInvoiceItems", () => {
  // Two identical invoices are exactly the case a real implementation would
  // pair completely — the boundary must not answer that with a silent,
  // plausible-looking empty triple.
  it("throws naming E6, even for two identical invoices", () => {
    expect(() => pairInvoiceItems(invoice, invoice)).toThrow(/E6/);
  });

  it("names both invoices passed in the error message", () => {
    expect(() => pairInvoiceItems(invoice, other)).toThrow(
      /previous=\[Claro Móvel@2026-07-01\.\.2026-07-31 \(1 items\)\].*current=\[Claro Móvel@2026-08-01\.\.2026-08-31 \(1 items\)\]/s,
    );
  });
});
