import { describe, expect, it } from "vitest";
import { containsPii, maskText } from "./mask.js";

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

  it("masks a formatted digitable line", () => {
    const line = "84670000001-2 23140268201-9 30202007202-5 60000000000-0";
    expect(maskText(line)).toBe("[LINHA_DIGITAVEL]");
  });

  it("masks a street address", () => {
    expect(maskText("Rua das Acácias, 128, apto 42")).toContain("[ENDERECO]");
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
