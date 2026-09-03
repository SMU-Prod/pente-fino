/** PRD §8.1, verbatim. Messages are pt-BR and ready to display. */
export const ERROR_CATALOGUE = {
  file_too_large: { http: 413, message: "Esse arquivo é maior que 15 MB. Tente enviar só as páginas da fatura." },
  unsupported_type: { http: 415, message: "Esse formato não é aceito. Envie PDF ou foto." },
  extraction_failed: { http: 422, message: "Não conseguimos ler essa fatura com segurança. Tente uma foto mais nítida." },
  quota_exceeded: { http: 402, message: "Você já usou sua análise gratuita deste mês." },
  rate_limited: { http: 429, message: "Muitos envios seguidos. Aguarde um minuto." },
  not_found: { http: 404, message: "Não encontramos esse item." },
  forbidden: { http: 403, message: "Você não tem acesso a esse item." },
  // E11 Task 4 — the admin panel's HTTP surface.
  rule_invalid: {
    http: 422,
    message: "Essa versão da regra não passou na validação. Corrija os campos indicados e envie de novo.",
  },
  proposal_conflict: {
    http: 409,
    message: "Não foi possível aplicar essa decisão agora. Atualize a lista de propostas e tente de novo.",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export function apiError(code: ErrorCode, details?: unknown, headers?: HeadersInit): Response {
  const { http, message } = ERROR_CATALOGUE[code];
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status: http, ...(headers === undefined ? {} : { headers }) },
  );
}
