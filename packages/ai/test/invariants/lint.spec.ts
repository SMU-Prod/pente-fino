import { describe, expect, it } from "vitest";
import { FORBIDDEN_TERMS } from "../../src/forbidden-terms.js";
import { lintUserFacingText } from "../../src/lint.js";

describe("INV-004 · every forbidden term of §14.3 is caught", () => {
  for (const term of FORBIDDEN_TERMS) {
    it(`rejects "${term}"`, () => {
      expect(lintUserFacingText(`Texto com ${term} no meio.`).ok).toBe(false);
    });
  }
});

describe("INV-005 · never promise a result", () => {
  for (const promise of [
    "garantimos o estorno",
    "garantia de devolução",
    "vamos ganhar essa",
    "você vai receber em dobro",
    "com certeza receberá o valor",
  ]) {
    it(`rejects "${promise}"`, () => {
      expect(lintUserFacingText(promise).ok).toBe(false);
    });
  }
});

describe("the approved column of §14.2 stays legal", () => {
  for (const approved of [
    "Encontramos R$ 25,45 para você verificar",
    "Texto pronto para você enviar",
    "A norma prevê devolução em dobro",
    "O prazo de 7 dias venceu sem resposta",
    "Não ficamos com nada do que você recuperar",
    "Não conseguimos ler essa fatura com segurança",
  ]) {
    it(`accepts "${approved}"`, () => {
      expect(lintUserFacingText(approved).ok).toBe(true);
    });
  }
});
