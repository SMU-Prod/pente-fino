import { describe, expect, it } from "vitest";
import { maskCanonical } from "../../src/invoice/mask.js";
import type { InvoiceCanonical } from "../../src/invoice/canonical.js";

const CPF_ANYWHERE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;

const dirty: InvoiceCanonical = {
  issuer: { name: "Claro Móvel", cnpj: "40432544000147", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [
    {
      name: "Titular",
      items: [
        { description: "Titular CPF 123.456.789-09", amountCents: 5000 },
        { description: "Rua das Acácias, 128", amountCents: 5000 },
      ],
    },
  ],
  extraction: { confidence: 0.9, warnings: ["CPF 987.654.321-00 ilegível"] },
};

describe("INV-007 · no PII is persisted in canonical", () => {
  it("leaves no CPF pattern anywhere in the serialised canonical", () => {
    const masked = JSON.stringify(maskCanonical(dirty));
    expect(CPF_ANYWHERE.test(masked)).toBe(false);
  });

  it("masks inside extraction warnings too, not only item descriptions", () => {
    const masked = maskCanonical(dirty);
    expect(masked.extraction.warnings.join(" ")).not.toMatch(CPF_ANYWHERE);
  });

  it("keeps the issuer cnpj, which is company data and not personal", () => {
    expect(maskCanonical(dirty).issuer.cnpj).toBe("40432544000147");
  });

  it("does not change the amounts", () => {
    expect(maskCanonical(dirty).sections[0]?.items[0]?.amountCents).toBe(5000);
  });
});
