import { describe, expect, it } from "vitest";
import { lintUserFacingText } from "./lint.js";

describe("lintUserFacingText", () => {
  it("accepts the approved phrasing of §14.2", () => {
    expect(lintUserFacingText("Encontramos R$ 25,45 para você verificar").ok).toBe(true);
  });

  it("rejects the promise of a result", () => {
    expect(lintUserFacingText("Garantimos o estorno").ok).toBe(false);
  });

  it("rejects presenting the system as counsel", () => {
    expect(lintUserFacingText("Nosso advogado envia a peça").ok).toBe(false);
  });

  it("rejects acting in the user's name", () => {
    expect(lintUserFacingText("Entraremos com a reclamação em seu nome").ok).toBe(false);
  });

  it("is case insensitive", () => {
    expect(lintUserFacingText("ADVOCACIA").ok).toBe(false);
  });

  it("ignores accents, so 'juridico' is caught like 'jurídico'", () => {
    expect(lintUserFacingText("parecer juridico").ok).toBe(false);
  });

  it("matches whole words only, so 'advogar-se' style substrings inside other words do not false positive", () => {
    expect(lintUserFacingText("Desagravo institucional").ok).toBe(true);
  });

  it("rejects an assertive 'indevido' about the user's own case", () => {
    expect(lintUserFacingText("Essa cobrança é indevida").ok).toBe(false);
  });

  it("allows 'indevido' inside a quoted norm", () => {
    const quoted = 'O CDC art. 42 fala em "cobrança indevida" e prevê devolução em dobro';
    expect(lintUserFacingText(quoted).ok).toBe(true);
  });

  it("allows 'ilegal' inside a quoted third party reply", () => {
    const quoted = 'A empresa respondeu: "não houve cobrança ilegal"';
    expect(lintUserFacingText(quoted).ok).toBe(true);
  });

  it("reports the offending term and where it is", () => {
    const result = lintUserFacingText("Garantimos tudo");
    expect(result.violations[0]?.term).toBe("garantimos");
    expect(result.violations[0]?.index).toBe(0);
  });
});

// The quoting rule in the brief pairs quote characters with a simple
// "next quote closes the previous one" regex. Probing it against realistic
// Brazilian Portuguese sentences (see task-6-report.md) found cases where
// that pairing lets an assertive claim slip through disguised as an allowed
// quotation — the unsafe direction for INV-004/INV-005, since this lint is
// the only deterministic gate against exactly that failure. These tests
// pin the hardened quote-boundary matcher that closes those gaps.
describe("lintUserFacingText — quote-boundary hardening", () => {
  it("does not let a stray straight quote (e.g. an inch mark) turn a real assertive claim into an allowed quotation", () => {
    // The `"` after "15" is a unit mark, not a citation opener. A naive
    // "next quote closes the previous one" pairing treats it as an opener
    // and swallows the assertive claim up to the next real quote character.
    const text = 'O aparelho tem 15" de tela, e por isso essa cobrança é indevida", conforme a nota fiscal.';
    const result = lintUserFacingText(text);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "indevida" && v.reason === "assertive")).toBe(true);
  });

  it("does not let an unclosed quote pair itself with an unrelated later quotation, swallowing assertive text in between", () => {
    // The opening quote here never actually closes. A naive pairing walks
    // forward to the next quote character at all — which happens to be the
    // *opening* quote of a second, independent citation — and treats that
    // as the first quote's close, exempting everything in between,
    // including the assertive "indevido".
    const text = '"Aviso legal aqui, sem fechamento verdadeiro e depois é indevido "citação seguinte real"';
    const result = lintUserFacingText(text);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "indevido" && v.reason === "assertive")).toBe(true);
  });

  it("still allows a term nested inside an outer quoted attribution", () => {
    // Nesting a straight-quoted phrase inside another straight-quoted
    // sentence is unusual in Portuguese typography, but when it happens the
    // inner citation should still count as a citation.
    const text = '"ela disse "cobrança indevida" agora"';
    expect(lintUserFacingText(text).ok).toBe(true);
  });
});
