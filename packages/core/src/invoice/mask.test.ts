import { describe, expect, it } from "vitest";
import { containsPii, maskCanonical, maskText } from "./mask.js";
import type { InvoiceCanonical } from "./canonical.js";

describe("maskText", () => {
  it("masks a formatted CPF", () => {
    expect(maskText("CPF 123.456.789-09")).toBe("CPF [CPF]");
  });

  it("masks a bare 11 digit CPF", () => {
    expect(maskText("12345678909")).toBe("[CPF]");
  });

  it("masks a formatted CNPJ", () => {
    expect(maskText("CNPJ 40.432.544/0001-47")).toBe("CNPJ [CNPJ]");
  });

  it("masks a 44 digit barcode", () => {
    expect(maskText("8" + "1".repeat(43))).toBe("[CODIGO_BARRAS]");
  });

  it("masks a formatted digitable line (convênio format)", () => {
    const line = "84670000001-2 23140268201-9 30202007202-5 60000000000-0";
    expect(maskText(line)).toBe("[LINHA_DIGITAVEL]");
  });

  it("masks a FEBRABAN bank-slip digitable line (5+5/5+6/5+6/1/14) as one token", () => {
    const line = "34191.79001 01043.510047 91020.150008 1 84660000019500";
    expect(maskText(line)).toBe("[LINHA_DIGITAVEL]");
  });

  it("masks a street address", () => {
    expect(maskText("Rua das Acácias, 128, apto 42")).toContain("[ENDERECO]");
  });

  it("masks a street name that contains digits, once a house number follows", () => {
    expect(maskText("Rua 7 de Setembro, 123")).toBe("[ENDERECO]");
    expect(maskText("Avenida 9 de Julho, 3000")).toBe("[ENDERECO]");
    expect(maskText("Rua 25 de Março, 500")).toBe("[ENDERECO]");
  });

  it("masks an address with no house number when marked s/n", () => {
    expect(maskText("Rua da Serra, s/n")).toBe("[ENDERECO]");
  });

  it("does not mask a street-type keyword with no house number, s/n or CEP", () => {
    expect(maskText("Praça de Alimentação")).toBe("Praça de Alimentação");
  });

  it("masks a labelled CEP", () => {
    expect(maskText("CEP: 04543-011")).toBe("[CEP]");
  });

  it("leaves an ordinary description untouched", () => {
    expect(maskText("Plano pós-pago 4G")).toBe("Plano pós-pago 4G");
  });

  it("does not mask a money amount that happens to have digits", () => {
    expect(maskText("Assinatura 12,90")).toBe("Assinatura 12,90");
  });
});

describe("containsPii", () => {
  it("finds a CPF", () => {
    expect(containsPii("123.456.789-09")).toBe(true);
  });

  it("is false for clean text", () => {
    expect(containsPii("Plano pós-pago")).toBe(false);
  });
});

// This is the assertion that would have caught Critical 3: containsPii and
// maskText used to disagree on which punctuation variants count as a CPF or
// CNPJ. Both now share the same structural pattern set, so for any input
// that carries one of these shapes, containsPii must see it before masking
// and must stop seeing it after.
describe("containsPii and maskText stay in sync", () => {
  const piiSamples = [
    "123.456.789-09",
    "123.456.78909",
    "123456.789-09",
    "123.456789-09",
    "12345678909",
    "CPF 123 456 789 09",
    "CNPJ 40.432.544/0001-47",
    "CNPJ 40 432 544 0001 47",
    "40432544000147",
    "Rua das Acácias, 128",
    "Rua 7 de Setembro, 123",
    "Rua da Serra, s/n",
    "CEP: 04543-011",
    "8" + "1".repeat(43),
    "84670000001-2 23140268201-9 30202007202-5 60000000000-0",
    "34191.79001 01043.510047 91020.150008 1 84660000019500",
  ];

  it.each(piiSamples)("detects PII in %j and clears it after masking", (sample) => {
    expect(containsPii(sample)).toBe(true);
    expect(containsPii(maskText(sample))).toBe(false);
  });
});

describe("maskCanonical", () => {
  const base: InvoiceCanonical = {
    issuer: { name: "Claro Móvel", cnpj: "40432544000147", category: "telecom" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 1000,
    sections: [{ name: "Detalhamento", items: [{ description: "Item", amountCents: 1000 }] }],
    extraction: { confidence: 0.9, warnings: [] },
  };

  it("masks every string value in item.meta but leaves numeric values alone", () => {
    const invoice: InvoiceCanonical = {
      ...base,
      sections: [
        {
          name: "Detalhamento",
          items: [
            {
              description: "Item com anotações do extrator",
              amountCents: 1000,
              meta: {
                holderName: "CPF 123.456.789-09",
                rawOcr: "Rua das Acácias, 128",
                lineNumber: 7,
              },
            },
          ],
        },
      ],
    };

    const maskedMeta = maskCanonical(invoice).sections[0]?.items[0]?.meta;
    expect(maskedMeta?.holderName).toBe("CPF [CPF]");
    expect(maskedMeta?.rawOcr).toBe("[ENDERECO]");
    expect(maskedMeta?.lineNumber).toBe(7);
  });

  it("masks periodRef when present, and does not add the field when absent", () => {
    const invoice: InvoiceCanonical = {
      ...base,
      sections: [
        {
          name: "Detalhamento",
          items: [
            {
              description: "Item com referência de período",
              amountCents: 1000,
              periodRef: "Titular CPF 123.456.789-09",
            },
            { description: "Item sem referência de período", amountCents: 500 },
          ],
        },
      ],
    };

    const maskedItems = maskCanonical(invoice).sections[0]?.items ?? [];
    expect(maskedItems[0]?.periodRef).toBe("Titular CPF [CPF]");
    expect(maskedItems[1]).not.toHaveProperty("periodRef");
  });
});
