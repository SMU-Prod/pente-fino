import { describe, expect, it } from "vitest";
import { lintUserFacingText } from "@pentefino/ai";
import * as copy from "../../app/laudo/[id]/copy.js";

/**
 * Every string this screen can render, including the ones only reachable
 * from the needs_review and forbidden/not_found branches (this task's
 * brief calls those out explicitly - a screen this early in the product is
 * the one place a defect is a sentence a person reads).
 */
function allStrings(): string[] {
  return [
    copy.HEADING,
    copy.totalToVerifyLine("R$ 25,45"),
    copy.doubledLine("R$ 50,90"),
    copy.TOTAL_TO_VERIFY_LABEL,
    copy.TOTAL_DOUBLED_LABEL,
    copy.AMOUNT_CHARGED_LABEL,
    copy.EMPTY_STATE,
    copy.FINDINGS_HEADING,
    copy.NEEDS_REVIEW_MESSAGE,
    copy.NEEDS_REVIEW_CTA,
    copy.CONFIDENCE_LABEL.verify,
    copy.CONFIDENCE_LABEL.likely,
    copy.DISMISS_BUTTON,
    copy.DISMISS_LOADING,
    copy.DISMISS_ANNOUNCEMENT,
    copy.FEEDBACK_ERROR,
    copy.PENDING_QUESTIONS_HEADING,
    copy.PENDING_QUESTIONS_INTRO,
    copy.ANSWER_LOADING,
    copy.ANSWER_ANNOUNCEMENT,
    copy.FALLBACK_QUESTION,
    copy.ACCESS_DENIED,
    copy.ITEM_NOT_FOUND,
    copy.BACK_HOME,
  ];
}

describe("laudo screen copy (§14.2/§14.3, INV-004)", () => {
  it("every string this screen can render passes lintUserFacingText", () => {
    for (const text of allStrings()) {
      const result = lintUserFacingText(text);
      expect(result.ok, `"${text}" violated: ${JSON.stringify(result.violations)}`).toBe(true);
    }
  });

  it("the default yes/no options also pass the lint", () => {
    for (const option of copy.DEFAULT_YES_NO) {
      expect(lintUserFacingText(option).ok).toBe(true);
    }
  });

  it("says 'para você verificar', never 'de cobrança ilegal' (§14.2)", () => {
    const line = copy.totalToVerifyLine("R$ 25,45");
    expect(line).toBe("Encontramos R$ 25,45 para você verificar.");
    expect(lintUserFacingText(line).ok).toBe(true);
  });

  it("says 'a norma prevê devolução em dobro', never 'você tem direito a receber' (§14.2)", () => {
    const line = copy.doubledLine("R$ 50,90");
    expect(line).toMatch(/^A norma prevê devolução em dobro/);
    expect(line).not.toMatch(/direito a receber/);
  });

  it("uses §8.1's needs_review wording verbatim", () => {
    expect(copy.NEEDS_REVIEW_MESSAGE).toBe(
      "Não conseguimos ler essa fatura com segurança. Tente uma foto mais nítida.",
    );
  });

  it("labels confidence in plain words, never a raw number (§13.3)", () => {
    expect(copy.CONFIDENCE_LABEL.verify).toBe("Verificar");
    expect(copy.CONFIDENCE_LABEL.likely).toBe("Provável cobrança a contestar");
    for (const label of Object.values(copy.CONFIDENCE_LABEL)) {
      expect(label).not.toMatch(/\d/);
    }
  });
});
