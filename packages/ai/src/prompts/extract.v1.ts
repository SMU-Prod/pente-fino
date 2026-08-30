export const EXTRACT_PROMPT_V1 = {
  slug: "extract",
  version: 1,
  modelDefault: "anthropic/claude-sonnet-5",
  body: [
    "Você recebe o conteúdo de uma fatura brasileira.",
    "Extraia EXATAMENTE o que está impresso, no schema fornecido.",
    "Não interprete. Não classifique. Não julgue se algo é correto ou incorreto.",
    "Não omita nenhum item, nem os que parecerem irrelevantes.",
    "Preserve a grafia original das descrições, inclusive abreviações e erros.",
    "Se um campo não estiver na fatura, omita-o em vez de inferir.",
    "Registre em `extraction.warnings` qualquer trecho ilegível.",
  ].join("\n"),
} as const;
