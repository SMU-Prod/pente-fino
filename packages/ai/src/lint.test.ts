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

  // A quoted norm or third-party reply is no longer recognized by the
  // presence of quote characters — see the "explicit citations" block below
  // for the replacement contract (Critical 1 of task-6-report.md).
  it("rejects 'indevido' quoted in a norm when no citation is declared", () => {
    const quoted = 'O CDC art. 42 fala em "cobrança indevida" e prevê devolução em dobro';
    const result = lintUserFacingText(quoted);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "indevida" && v.reason === "assertive")).toBe(true);
  });

  it("rejects 'ilegal' quoted in a third-party reply when no citation is declared", () => {
    const quoted = 'A empresa respondeu: "não houve cobrança ilegal"';
    const result = lintUserFacingText(quoted);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "ilegal" && v.reason === "assertive")).toBe(true);
  });

  it("reports the offending term and where it is", () => {
    const result = lintUserFacingText("Garantimos tudo");
    expect(result.violations[0]?.term).toBe("garantimos");
    expect(result.violations[0]?.index).toBe(0);
  });
});

/**
 * Critical 1 (task-6-report.md): the lint used to infer a citation from
 * whether a conditional term sat between quote characters. Wrapping a
 * sentence in quotes was enough to exempt it, whether or not the text was
 * actually quoting a norm or a third party. The lint cannot tell a citation
 * from the system's own claim just by looking at punctuation, so it no
 * longer tries: the caller must declare the exact span via
 * `options.citations` (RF-161 — a legal reference always comes from the
 * rule that fired, never from the model; a third-party reply arrives in its
 * own field). These tests pin that contract on both sides.
 */
describe("lintUserFacingText — explicit citations (PRD §14.3)", () => {
  it("allows 'indevido' quoted in a norm once its span is declared as a citation", () => {
    const quoted = 'O CDC art. 42 fala em "cobrança indevida" e prevê devolução em dobro';
    const start = quoted.indexOf("indevida");
    const end = start + "indevida".length;
    expect(lintUserFacingText(quoted, { citations: [{ start, end }] }).ok).toBe(true);
  });

  it("allows 'ilegal' quoted in a third-party reply once its span is declared as a citation", () => {
    const quoted = 'A empresa respondeu: "não houve cobrança ilegal"';
    const start = quoted.indexOf("ilegal");
    const end = start + "ilegal".length;
    expect(lintUserFacingText(quoted, { citations: [{ start, end }] }).ok).toBe(true);
  });

  it("rejects the audited defect sentence when no citation is declared, even though it is wrapped in quotes", () => {
    // The exact sentence from the Critical 1 reproduction: wrapping an
    // assertive claim in quote marks alone used to be enough to pass.
    const text = '"Essa cobrança é claramente indevida e ilegal, você tem razão"';
    const result = lintUserFacingText(text);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "indevida" && v.reason === "assertive")).toBe(true);
    expect(result.violations.some((v) => v.term === "ilegal" && v.reason === "assertive")).toBe(true);
  });

  it("allows the audited defect sentence once its whole span is declared as a citation", () => {
    const text = '"Essa cobrança é claramente indevida e ilegal, você tem razão"';
    const result = lintUserFacingText(text, { citations: [{ start: 0, end: text.length }] });
    expect(result.ok).toBe(true);
  });

  it("never exempts a FORBIDDEN_TERMS term, even fully inside a declared citation", () => {
    // §14.3 grants the citation exemption to the conditional terms
    // ("indevido"/"indevida"/"ilegal") alone. A FORBIDDEN_TERMS term must
    // stay a violation no matter what the caller declares.
    const text = 'O texto padrão diz: "garantimos o reembolso em até 5 dias"';
    const start = text.indexOf("garantimos");
    const end = start + "garantimos".length;
    const result = lintUserFacingText(text, { citations: [{ start, end }] });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "garantimos" && v.reason === "forbidden")).toBe(true);
  });

  it("does not exempt a conditional term when the citation only partly covers it", () => {
    const text = "Essa cobrança é indevida.";
    const start = text.indexOf("indevida");
    const end = start + 4; // covers only "inde", not the whole match
    const result = lintUserFacingText(text, { citations: [{ start, end }] });
    expect(result.ok).toBe(false);
  });

  it("exempts a term covered by one of several overlapping citation ranges", () => {
    const text = "Conforme a resposta, isso é indevido no caso.";
    const start = text.indexOf("indevido");
    const end = start + "indevido".length;
    const result = lintUserFacingText(text, {
      citations: [
        { start: start - 5, end: end - 2 }, // overlaps, but does not fully cover the term
        { start, end }, // fully covers it
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("exempts a term when its covering citation is declared out of order relative to other citations", () => {
    const text = "Primeiro trecho indevido, depois outro ilegal aqui.";
    const iStart = text.indexOf("indevido");
    const iEnd = iStart + "indevido".length;
    const lStart = text.indexOf("ilegal");
    const lEnd = lStart + "ilegal".length;
    const result = lintUserFacingText(text, {
      citations: [
        { start: lStart, end: lEnd }, // the later term's citation listed first
        { start: iStart, end: iEnd },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("does not exempt anything via a citation with reversed bounds (start > end)", () => {
    const text = "Essa cobrança é indevida.";
    const start = text.indexOf("indevida");
    const end = start + "indevida".length;
    const result = lintUserFacingText(text, { citations: [{ start: end, end: start }] });
    expect(result.ok).toBe(false);
  });
});

/**
 * Critical 2 (task-6-report.md): a multi-word term's escaped needle kept
 * its literal space, so it only matched a single ASCII space between the
 * words. Any other run of whitespace — a line break, a tab, more than one
 * space, a non-breaking space — defeated the match entirely. These are the
 * exact sentences from the reproduction, plus the other whitespace kinds
 * the fix is required to cover.
 */
describe("lintUserFacingText — multi-word terms match across any whitespace", () => {
  it("catches 'em seu nome' split across a line break", () => {
    expect(lintUserFacingText("Isso é feito em seu\nnome, com cuidado.").ok).toBe(false);
  });

  it("catches 'garantia de' separated by more than one space", () => {
    expect(lintUserFacingText("Existe uma garantia  de devolução total.").ok).toBe(false);
  });

  it("catches 'ação judicial' split across a line break", () => {
    expect(lintUserFacingText("Podemos abrir uma ação\njudicial se necessário.").ok).toBe(false);
  });

  it("catches a multi-word term separated by a tab", () => {
    expect(lintUserFacingText("Vamos entrar com uma ação\tjudicial já.").ok).toBe(false);
  });

  it("catches a multi-word term separated by a non-breaking space", () => {
    expect(lintUserFacingText("Isso é feito em seu nome.").ok).toBe(false);
  });
});

describe("lintUserFacingText — violation indices stay aligned to the original text", () => {
  it("points at the right substring even when an accented character precedes the term", () => {
    // NFD-folding an accented character (e.g. "á") temporarily lengthens
    // the string before the combining mark is stripped back out, so this
    // pins that the net effect is length-preserving and indices still
    // point at the right place in the ORIGINAL (unfolded) text.
    const text = "Já é claro: garantimos o reembolso.";
    const result = lintUserFacingText(text);
    const violation = result.violations.find((v) => v.term === "garantimos");
    expect(violation).toBeDefined();
    expect(text.slice(violation!.index, violation!.index + "garantimos".length).toLowerCase()).toBe("garantimos");
  });
});

/**
 * These tests originally pinned a heuristic that inferred a citation from
 * the shape of quote characters (open/close matching, abort-on-fresh-opener
 * for an unclosed quote). That heuristic — and the "was this text quoted?"
 * question it tried to answer — is gone; see `lintUserFacingText`'s doc
 * comment in lint.ts. Quote characters are now just punctuation like any
 * other, so these are now regression tests confirming they carry no
 * special meaning at all: the first two already expected a violation
 * despite the quotes, and still do. The third originally expected quoting
 * alone to grant an exemption; it is replaced below with the two-sided
 * citation contract, same as the other tests that asserted that contract.
 */
describe("lintUserFacingText — quote characters carry no special meaning", () => {
  it("still rejects an assertive claim next to a stray straight quote (e.g. an inch mark)", () => {
    const text = 'O aparelho tem 15" de tela, e por isso essa cobrança é indevida", conforme a nota fiscal.';
    const result = lintUserFacingText(text);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "indevida" && v.reason === "assertive")).toBe(true);
  });

  it("still rejects assertive text sitting between an unclosed quote and an unrelated later quotation", () => {
    const text = '"Aviso legal aqui, sem fechamento verdadeiro e depois é indevido "citação seguinte real"';
    const result = lintUserFacingText(text);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "indevido" && v.reason === "assertive")).toBe(true);
  });

  it("rejects a term nested inside literal quote characters when no citation is declared", () => {
    const text = '"ela disse "cobrança indevida" agora"';
    const result = lintUserFacingText(text);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.term === "indevida" && v.reason === "assertive")).toBe(true);
  });

  it("allows the nested term once its exact span is declared as a citation", () => {
    const text = '"ela disse "cobrança indevida" agora"';
    const start = text.indexOf("indevida");
    const end = start + "indevida".length;
    expect(lintUserFacingText(text, { citations: [{ start, end }] }).ok).toBe(true);
  });
});
