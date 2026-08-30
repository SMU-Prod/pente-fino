/** The list of PRD §14.3, verbatim. */
export const FORBIDDEN_TERMS = [
  "advogado", "advogada", "advocacia", "jurídico", "jurídica",
  "assessoria jurídica", "consultoria jurídica", "parecer", "patrocínio",
  "representamos", "em seu nome", "entraremos com",
  "processo judicial", "ação judicial",
  "garantimos", "garantia de", "vamos ganhar", "você vai receber",
  "com certeza receberá",
] as const;

/**
 * "indevido" and "ilegal" are allowed only when quoting a norm or a third
 * party. Asserted about the user's own case they are forbidden, so they are
 * handled separately from the flat list above.
 */
export const CONDITIONAL_TERMS = ["indevido", "indevida", "ilegal"] as const;
