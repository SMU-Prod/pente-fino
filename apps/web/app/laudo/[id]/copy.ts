import { ERROR_CATALOGUE } from "@/lib/errors.js";

/**
 * Every pt-BR string the `/laudo/[id]` screen (RF-143, RF-144) can render,
 * in one place - `test/laudo/copy.test.ts` asserts every one of them
 * against `lintUserFacingText` (INV-004, §14.3), including the strings
 * only an error or needs_review path produces. §14.2's mandated phrasing is
 * quoted here, not paraphrased: the "Dizer" column, verbatim, with the
 * amount interpolated.
 *
 * Code and comments are English; every exported value is the pt-BR text a
 * person actually reads.
 */

export const HEADING = "Seu laudo";

/** §14.2: "Encontramos R$ 25,45 para você verificar" - never "de cobrança ilegal". */
export function totalToVerifyLine(amount: string): string {
  return `Encontramos ${amount} para você verificar.`;
}

/** §14.2: "A norma prevê devolução em dobro" - never "você tem direito a receber". */
export function doubledLine(amount: string): string {
  return `A norma prevê devolução em dobro: ${amount} no total.`;
}

export const TOTAL_TO_VERIFY_LABEL = "Total a verificar";
export const TOTAL_DOUBLED_LABEL = "Total em dobro, se você contestar";
export const AMOUNT_CHARGED_LABEL = "Valor cobrado";

export const FINDINGS_HEADING = "Achados";

/** §13.3: every empty state is written, never a blank area. */
export const EMPTY_STATE = "Conferimos sua fatura e não encontramos nada para você questionar desta vez.";

/** §8.1, verbatim - RF-144's own screen never assembles a report from a partial read. */
export const NEEDS_REVIEW_MESSAGE = ERROR_CATALOGUE.extraction_failed.message;
export const NEEDS_REVIEW_CTA = "Enviar uma foto mais nítida";

/**
 * RF-124/§13.3: confidence in plain words, never a raw number. There is no
 * label for the "question" band on purpose - a question is not a confidence
 * level, it is something the screen asks instead of asserting.
 */
export const CONFIDENCE_LABEL = {
  verify: "Verificar",
  likely: "Provável cobrança a contestar",
} as const;

export const DISMISS_BUTTON = "Isso eu contratei";
export const DISMISS_LOADING = "Registrando sua resposta…";
export const DISMISS_ANNOUNCEMENT = "Marcado como contratado. Removido da lista.";
export const FEEDBACK_ERROR = "Não conseguimos registrar sua resposta agora. Tente de novo.";

export const PENDING_QUESTIONS_HEADING = "Perguntas pendentes";
export const PENDING_QUESTIONS_INTRO = "Para avaliar isto direito, precisamos que você responda:";
export const ANSWER_LOADING = "Enviando sua resposta…";
export const ANSWER_ANNOUNCEMENT = "Resposta registrada. Obrigado!";

// Defensive fallback only: RF-124 has the engine create a confirm-kind rule
// (and therefore an `askUser`) for every finding it bands as a question, so
// this should never actually render. It exists so a data shape that drifts
// from that invariant still reads as a written question, not a crash.
export const FALLBACK_QUESTION = "Você reconhece esta cobrança?";
export const DEFAULT_YES_NO = ["Sim", "Não"] as const;

export const ACCESS_DENIED = ERROR_CATALOGUE.forbidden.message;
export const ITEM_NOT_FOUND = ERROR_CATALOGUE.not_found.message;
export const BACK_HOME = "Voltar para o início";
