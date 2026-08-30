import { describe, expect, it } from "vitest";
import { InvoiceCanonical } from "./canonical.js";

const valid = {
  issuer: { name: "Claro Móvel", cnpj: "40432544000147", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 12990,
  sections: [
    { name: "Serviços", items: [{ description: "Plano pós-pago", amountCents: 9990 }] },
  ],
  extraction: { confidence: 0.94, warnings: [] },
};

describe("InvoiceCanonical", () => {
  it("accepts a minimal valid invoice", () => {
    expect(InvoiceCanonical.parse(valid)).toBeTruthy();
  });

  it("rejects a section with no items", () => {
    const bad = { ...valid, sections: [{ name: "Vazia", items: [] }] };
    expect(InvoiceCanonical.safeParse(bad).success).toBe(false);
  });

  it("rejects a negative total", () => {
    expect(InvoiceCanonical.safeParse({ ...valid, totalCents: -1 }).success).toBe(false);
  });

  it("rejects a cnpj that is not 14 digits", () => {
    const bad = { ...valid, issuer: { ...valid.issuer, cnpj: "404325" } };
    expect(InvoiceCanonical.safeParse(bad).success).toBe(false);
  });

  it("rejects a category outside the four of §1.3", () => {
    const bad = { ...valid, issuer: { ...valid.issuer, category: "insurance" } };
    expect(InvoiceCanonical.safeParse(bad).success).toBe(false);
  });

  it("allows a negative item amount, because credits are items too", () => {
    const credit = {
      ...valid,
      sections: [{ name: "Créditos", items: [{ description: "Estorno", amountCents: -500 }] }],
    };
    expect(InvoiceCanonical.safeParse(credit).success).toBe(true);
  });

  it("keeps confidence inside 0..1", () => {
    const bad = { ...valid, extraction: { confidence: 1.4, warnings: [] } };
    expect(InvoiceCanonical.safeParse(bad).success).toBe(false);
  });
});
