/**
 * Every pt-BR string RF-146's public `/l/[token]` page (and its
 * `not-found.tsx`) can render, in one place - `test/l/copy.test.ts` asserts
 * every one of them against `lintUserFacingText` (INV-004, §14.3). This is
 * the product's first surface reachable with no session at all: a stranger
 * who followed a shared link, deciding whether to check their own bill,
 * reads every one of these words before they have any other reason to
 * trust this product.
 *
 * Deliberately duplicates a few strings/functions that already exist in
 * `apps/web/app/laudo/[id]/copy.ts` and
 * `apps/web/app/api/card/[token]/route.tsx` rather than importing them:
 * this page answers the same §14.2 wording, but is its own public surface
 * (INV-008's deliberate `withUser` exception) with its own, narrower data
 * shape. This codebase's own convention - see `formatCentsBRL`'s own
 * duplicated copy in both of those files, each with a comment pointing at
 * the other - is to duplicate a small pure string/function across route
 * boundaries with a cross-referencing comment, rather than introduce a
 * shared module that two independently-evolving public surfaces would both
 * depend on.
 *
 * Code and comments are English; every exported value is the pt-BR text a
 * person actually reads.
 */

export const BRAND = "Pente-fino";
export const EYEBROW = "Laudo compartilhado";

/** §14.2, verbatim: "para você verificar" - never "de cobrança ilegal". */
export function totalToVerifyLine(amount: string): string {
  return `Encontramos ${amount} para você verificar.`;
}

/** §14.2, verbatim: "a norma prevê devolução em dobro" - never "você tem direito a receber". */
export function doubledLine(amount: string): string {
  return `A norma prevê devolução em dobro: ${amount} no total.`;
}

export function findingsLine(count: number): string {
  return count === 1 ? "1 cobrança para revisar" : `${count} cobranças para revisar`;
}

export const TOTAL_TO_VERIFY_LABEL = "Total a verificar";
export const TOTAL_DOUBLED_LABEL = "Total em dobro, se você contestar";

/**
 * §13.3: every empty state is written, never a blank area - a shared
 * report with nothing left to flag still says so, and still carries the
 * same upload call to action below it.
 */
export const CLEAN_REPORT_MESSAGE = "Não encontramos cobrança a mais nesta fatura - mas vale sempre conferir a sua.";

// --- the upload call to action - the product's acquisition path for
// whoever lands here from a shared link with no account of their own.

export const CTA_HEADING = "Desconfia que a sua fatura também tem cobrança a mais?";
export const CTA_BODY = "Envie a sua e descubra em minutos, sem precisar criar conta.";
export const CTA_BUTTON = "Conferir minha fatura";

/**
 * Shown by `not-found.tsx` for both an unknown token and a revoked one
 * (RF-146's acceptance: the two are indistinguishable) - phrased so it
 * reads honestly in either case without saying which one it was, the same
 * principle `/laudo/[id]`'s own `ITEM_NOT_FOUND` follows for another
 * session's invoice (see that file's own comment).
 */
export const NOT_FOUND_MESSAGE = "Este laudo não está mais disponível.";
export const BACK_HOME = "Voltar para o início";
