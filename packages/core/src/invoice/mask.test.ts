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

  // Critical 2 (fix pass 2): the address rule used to require the house
  // number right after the *first* comma following the street keyword, so
  // any descriptive clause in between made it miss the address entirely,
  // or — worse — re-anchor on a keyword embedded in that clause and mask
  // only a fragment of the real address.
  describe("address spans across descriptive clauses (Critical 2)", () => {
    it("masks a street name followed by a neighbourhood clause before the house number", () => {
      expect(maskText("Rua Bahia, Bairro Centro, 88")).toBe("[ENDERECO]");
    });

    it("masks a street name followed by a landmark clause before the house number", () => {
      expect(maskText("Av. Brasil, esquina com a padaria, 200")).toBe("[ENDERECO]");
    });

    it("masks the whole span as one token even when a second street keyword sits inside it", () => {
      // Must not re-anchor on "praça" and only mask the trailing fragment.
      expect(maskText("Rua das Flores, próximo à praça central, 45")).toBe("[ENDERECO]");
    });

    it("still leaves a bare street-type keyword alone when no number ever follows", () => {
      expect(maskText("Praça de Alimentação")).toBe("Praça de Alimentação");
    });
  });

  // Critical 3 (fix pass 2): counting digits cannot tell a document number
  // from a phone number, a meter reading, a protocol number, a product
  // code or a monetary amount. These must all survive masking untouched.
  describe("digit runs that are not document numbers survive (Critical 3)", () => {
    it("does not mask a mobile phone number (11 digits with area code)", () => {
      expect(maskText("11 91234-5678")).toBe("11 91234-5678");
    });

    it("does not mask an 11-digit water meter reading", () => {
      expect(maskText("Leitura hidrômetro 12345678901")).toBe("Leitura hidrômetro 12345678901");
    });

    it("does not mask a 14-digit protocol number", () => {
      expect(maskText("Protocolo 12345678901234")).toBe("Protocolo 12345678901234");
    });

    it("does not mask a 14-digit EAN barcode as a CNPJ", () => {
      expect(maskText("07894900011527")).toBe("07894900011527");
    });

    it("does not corrupt a monetary amount that totals 11 digits before the decimal comma", () => {
      expect(maskText("R$ 12.345.678.901,23")).toBe("R$ 12.345.678.901,23");
    });

    it("does not mask a monetary amount without the R$ sign either, via the decimal-comma guard", () => {
      expect(maskText("Total 12.345.678.901,23")).toBe("Total 12.345.678.901,23");
    });
  });

  describe("check-digit validation (Critical 3)", () => {
    it("masks a real CPF with valid check digits and no label", () => {
      expect(maskText("12345678909")).toBe("[CPF]");
    });

    it("does not mask an 11-digit run with the right shape but invalid check digits", () => {
      expect(maskText("11122233344")).toBe("11122233344");
    });

    it("does not mask a 14-digit run with the right shape but invalid check digits", () => {
      expect(maskText("11122233344455")).toBe("11122233344455");
    });
  });

  describe("labelled runs mask despite failing check digits (OCR damage guard)", () => {
    it("masks a CPF label followed by a run with a damaged check digit", () => {
      expect(maskText("CPF: 123.456.789-00")).toBe("CPF: [CPF]");
    });

    it("masks a CNPJ label followed by a run with damaged check digits", () => {
      expect(maskText("CNPJ 40.432.544/0001-00")).toBe("CNPJ [CNPJ]");
    });

    it("masks a CPF/MF label followed by a run with a damaged check digit", () => {
      expect(maskText("CPF/MF 123.456.789-00")).toBe("CPF/MF [CPF]");
    });
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
    "CPF: 123.456.789-00", // damaged check digit, but labelled — still PII
    "CNPJ 40.432.544/0001-00", // same, for CNPJ
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

  // Critical 1 (fix pass 2): item.meta is typed `string | number` (see
  // canonical.ts), but the old maskMeta only ever masked string values, so
  // a CPF or CNPJ captured by the extractor as a number round-tripped raw.
  it("masks a numeric meta value that is a real CPF, replacing it with the marker string", () => {
    const invoice: InvoiceCanonical = {
      ...base,
      sections: [
        {
          name: "Detalhamento",
          items: [
            {
              description: "Item com CPF numerico no meta",
              amountCents: 1000,
              meta: { holderCpf: 12345678909 },
            },
          ],
        },
      ],
    };

    const masked = maskCanonical(invoice).sections[0]?.items[0]?.meta;
    expect(masked?.holderCpf).toBe("[CPF]");
  });

  it("masks a numeric meta value that is a real CNPJ, replacing it with the marker string", () => {
    const invoice: InvoiceCanonical = {
      ...base,
      sections: [
        {
          name: "Detalhamento",
          items: [
            {
              description: "Item com CNPJ numerico no meta",
              amountCents: 1000,
              meta: { holderCnpj: 40432544000147 },
            },
          ],
        },
      ],
    };

    const masked = maskCanonical(invoice).sections[0]?.items[0]?.meta;
    expect(masked?.holderCnpj).toBe("[CNPJ]");
  });

  it("leaves an ordinary numeric meta value (not PII) as a number, unchanged", () => {
    const invoice: InvoiceCanonical = {
      ...base,
      sections: [
        {
          name: "Detalhamento",
          items: [
            {
              description: "Item com contador no meta",
              amountCents: 1000,
              meta: { pageCount: 42 },
            },
          ],
        },
      ],
    };

    const masked = maskCanonical(invoice).sections[0]?.items[0]?.meta;
    expect(masked?.pageCount).toBe(42);
  });
});
