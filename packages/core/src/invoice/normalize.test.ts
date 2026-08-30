import { describe, expect, it } from "vitest";
import { normalizeDescription } from "./normalize.js";

describe("normalizeDescription", () => {
  it("matches the two spellings from RF-122", () => {
    expect(normalizeDescription("Serviços de valor adicionado(SVA)"))
      .toBe(normalizeDescription("SERVICOS DE VALOR ADICIONADO (SVA)"));
  });

  it("uppercases", () => {
    expect(normalizeDescription("plano")).toBe("PLANO");
  });

  it("strips accents and turns Ç into C", () => {
    expect(normalizeDescription("Serviço Adicional")).toBe("SERVICO ADICIONAL");
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeDescription("A   B\tC")).toBe("A B C");
  });

  it("trims the edges", () => {
    expect(normalizeDescription("  PLANO  ")).toBe("PLANO");
  });

  it("removes variable numbers so recurring items match across cycles", () => {
    expect(normalizeDescription("Pacote 07/2026")).toBe(normalizeDescription("Pacote 08/2026"));
  });

  it("keeps letters that sit next to digits, because they carry meaning", () => {
    expect(normalizeDescription("Plano 4G")).toBe("PLANO 4G");
  });

  it("puts a space where punctuation joined two words", () => {
    expect(normalizeDescription("ADICIONADO(SVA)")).toBe("ADICIONADO SVA");
  });

  it("is idempotent", () => {
    const once = normalizeDescription("Serviços de valor adicionado(SVA)");
    expect(normalizeDescription(once)).toBe(once);
  });
});
