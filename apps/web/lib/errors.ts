/** PRD §8.1, verbatim. Messages are pt-BR and ready to display. */
export const ERROR_CATALOGUE = {
  file_too_large: { http: 413, message: "Esse arquivo é maior que 15 MB. Tente enviar só as páginas da fatura." },
  unsupported_type: { http: 415, message: "Esse formato não é aceito. Envie PDF ou foto." },
  extraction_failed: { http: 422, message: "Não conseguimos ler essa fatura com segurança. Tente uma foto mais nítida." },
  quota_exceeded: { http: 402, message: "Você já usou sua análise gratuita deste mês." },
  rate_limited: { http: 429, message: "Muitos envios seguidos. Aguarde um minuto." },
  not_found: { http: 404, message: "Não encontramos esse item." },
  forbidden: { http: 403, message: "Você não tem acesso a esse item." },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export function apiError(code: ErrorCode, details?: unknown, headers?: HeadersInit): Response {
  const { http, message } = ERROR_CATALOGUE[code];
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status: http, ...(headers === undefined ? {} : { headers }) },
  );
}
