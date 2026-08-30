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

  it("keeps a dot-joined digit glued to its letter, distinct from the plain form", () => {
    const result = normalizeDescription("Plano 4.5G");
    expect(result).toContain("45G");
    expect(result).not.toBe(normalizeDescription("Plano 4G"));
  });

  it("tells apart data tiers that differ only by a comma-decimal", () => {
    expect(normalizeDescription("Pacote de dados 20,5GB"))
      .not.toBe(normalizeDescription("Pacote de dados 10,5GB"));
  });

  it("keeps both tokens distinguishable when a plain and a decimal digit run share a line", () => {
    const result = normalizeDescription("Internet 4G/4.5G");
    expect(result).toContain("4G");
    expect(result).toContain("45G");
    expect(result).not.toBe(normalizeDescription("Internet 4G/4G"));
  });

  it("is idempotent for digit-punctuation-digit inputs", () => {
    for (const input of ["Plano 4.5G", "Pacote de dados 20,5GB", "Pacote de dados 10,5GB", "Internet 4G/4.5G"]) {
      const once = normalizeDescription(input);
      expect(normalizeDescription(once)).toBe(once);
    }
  });

  it("tells apart tiers that differ only by a digit-punctuation-letter join", () => {
    expect(normalizeDescription("Plano 4-G")).not.toBe(normalizeDescription("Plano 5-G"));
  });

  it("tells apart data caps that differ only by a digit-punctuation-letter join", () => {
    expect(normalizeDescription("Internet 10-GB")).not.toBe(normalizeDescription("Internet 20-GB"));
  });

  it("still separates a letter-punctuation-letter join into two words", () => {
    expect(normalizeDescription("PLANO-MASTER")).toBe("PLANO MASTER");
  });

  it("is idempotent for digit-punctuation-letter inputs", () => {
    for (const input of ["Plano 4-G", "Plano 5-G", "Internet 10-GB", "Internet 20-GB"]) {
      const once = normalizeDescription(input);
      expect(normalizeDescription(once)).toBe(once);
    }
  });

  it("matches a hyphen-joined recurring line across cycles even when the cycle is glued to the word", () => {
    expect(normalizeDescription("Mensalidade-01/2026")).toBe(normalizeDescription("Mensalidade-02/2026"));
  });

  it("matches another hyphen-joined recurring line across cycles", () => {
    expect(normalizeDescription("Parcela-07/2026")).toBe(normalizeDescription("Parcela-08/2026"));
  });

  it("does not mistake a three-digit fraction for a date", () => {
    expect(normalizeDescription("Plano 4.55G")).toContain("455G");
  });

  it("is idempotent for hyphen-joined cycle references", () => {
    for (const input of ["Mensalidade-01/2026", "Mensalidade-02/2026", "Parcela-07/2026", "Parcela-08/2026", "Plano 4.55G"]) {
      const once = normalizeDescription(input);
      expect(normalizeDescription(once)).toBe(once);
    }
  });
});
