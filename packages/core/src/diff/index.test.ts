import { describe, expect, it } from "vitest";
import { diffInvoices } from "./index.js";
import type { InvoiceCanonical } from "../invoice/canonical.js";

const invoice = {
  issuer: { name: "Claro Móvel", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
  extraction: { confidence: 0.9, warnings: [] },
} as InvoiceCanonical;

describe("diffInvoices", () => {
  it("returns an empty pairing until E6 implements it", () => {
    expect(diffInvoices(invoice, invoice)).toEqual({ paired: [], disappeared: [], appeared: [] });
  });
});
