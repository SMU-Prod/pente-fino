import { describe, expect, it } from "vitest";
import { maskCanonical } from "../../src/invoice/mask.js";
import type { InvoiceCanonical } from "../../src/invoice/canonical.js";

const CPF_ANYWHERE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;

// Independent probes for the strengthened check below, deliberately not
// imported from mask.ts: the point is to verify the invariant with an oracle
// that does not share code with the implementation under test.
const CPF_STRUCTURAL = /\b(?:\d[.\-/ ]?){10}\d\b/;
const CNPJ_STRUCTURAL = /\b(?:\d[.\-/ ]?){13}\d\b/;
const ADDRESS_SHAPE = /\b(?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rodovia|Estrada)\b[^,;]*,\s*(?:\d+|s\/n)/i;
const BARCODE_SHAPE = /\b\d{44}\b/;
const DIGITABLE_LINE_SHAPE =
  /\b\d{5}\.?\d{5}\s?\d{5}\.?\d{6}\s?\d{5}\.?\d{6}\s?\d\s?\d{14}\b|\b\d{11}-?\d\s+\d{11}-?\d\s+\d{11}-?\d\s+\d{11}-?\d\b/;

const dirty: InvoiceCanonical = {
  issuer: { name: "Claro Móvel", cnpj: "40432544000147", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [
    {
      name: "Titular CPF 123.456.789-09",
      items: [
        { description: "Titular CPF 123.456.789-09", amountCents: 5000 },
        { description: "Rua das Acácias, 128", amountCents: 5000 },
        {
          description: "Boleto do mês, código anexo",
          amountCents: 0,
          periodRef: "CNPJ do responsável 12.345.678/0001-95",
          meta: {
            barcode: "8" + "1".repeat(43),
            digitableLine: "34191.79001 01043.510047 91020.150008 1 84660000019500",
            lineNumber: 42,
          },
        },
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

  // Every bug fixed in this pass (item.meta never masked, the FEBRABAN
  // digitable line unrecognised, the CPF/CNPJ detector-redactor mismatch,
  // and the two address false negatives) was invisible to a CPF-only
  // assertion. This test seeds all five PII kinds INV-007 names — CPF, the
  // holder's CNPJ, address, barcode and digitable line — spread across
  // every field maskCanonical touches (item descriptions, section names,
  // periodRef, meta string values and extraction warnings), and checks that
  // none of the five survives serialisation.
  it("leaves none of CPF, holder CNPJ, address, barcode or digitable line anywhere after masking", () => {
    const masked = maskCanonical(dirty);
    // The issuer CNPJ is company data, not personal, and is asserted to
    // survive untouched separately below — exclude it here so this check
    // is only about personal data that must not survive.
    const { issuer: _issuer, ...personalDataSurface } = masked;
    const serialised = JSON.stringify(personalDataSurface);

    expect(serialised).not.toMatch(CPF_STRUCTURAL);
    expect(serialised).not.toMatch(CNPJ_STRUCTURAL);
    expect(serialised).not.toMatch(ADDRESS_SHAPE);
    expect(serialised).not.toMatch(BARCODE_SHAPE);
    expect(serialised).not.toMatch(DIGITABLE_LINE_SHAPE);
  });

  it("keeps the issuer cnpj, which is company data and not personal", () => {
    expect(maskCanonical(dirty).issuer.cnpj).toBe("40432544000147");
  });

  it("does not change the amounts", () => {
    expect(maskCanonical(dirty).sections[0]?.items[0]?.amountCents).toBe(5000);
  });
});
