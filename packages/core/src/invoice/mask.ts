import type { InvoiceCanonical } from "./canonical.js";

/**
 * Masking rules for RF-109 / INV-007. Order matters: the longest and most
 * specific patterns run first, so a digitable line is not eaten piecemeal
 * by the barcode or CPF patterns.
 */
const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b\d{5}\.?\d{6}\s?\d{5}\.?\d{6}\s?\d{5}\.?\d{6}\s?\d\s?\d{14}\b/g, replacement: "[LINHA_DIGITAVEL]" },
  { pattern: /\b\d{11}-?\d\s+\d{11}-?\d\s+\d{11}-?\d\s+\d{11}-?\d\b/g, replacement: "[LINHA_DIGITAVEL]" },
  { pattern: /\b\d{44}\b/g, replacement: "[CODIGO_BARRAS]" },
  { pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, replacement: "[CNPJ]" },
  { pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, replacement: "[CPF]" },
  { pattern: /\b\d{11}\b/g, replacement: "[CPF]" },
  // The house number after the comma is required, not optional: it is what
  // separates a genuine address ("Praça da República, 45") from ordinary
  // prose that happens to use the same words generically ("Praça de
  // Alimentação", "Praça de Pedágio") — common in card-statement merchant
  // descriptions, which never carry a trailing ", <number>".
  {
    pattern: /\b(?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rodovia|Estrada)\b[^,;\d]*,\s*\d+[^,;]*(?:,\s*(?:apto|ap\.?|bloco|casa)\s*\S+)?/gi,
    replacement: "[ENDERECO]",
  },
];

export function maskText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const PII_PROBES = [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, /\b\d{44}\b/];

export function containsPii(text: string): boolean {
  return PII_PROBES.some((probe) => probe.test(text));
}

/**
 * Returns a copy of the canonical invoice with personal data replaced by
 * markers. The issuer CNPJ survives: it identifies the company, not the
 * person, and the tariff join of RN-040 depends on it.
 */
export function maskCanonical(invoice: InvoiceCanonical): InvoiceCanonical {
  return {
    ...invoice,
    sections: invoice.sections.map((section) => ({
      ...section,
      name: maskText(section.name),
      items: section.items.map((item) => ({
        ...item,
        description: maskText(item.description),
        ...(item.periodRef === undefined ? {} : { periodRef: maskText(item.periodRef) }),
      })),
    })),
    extraction: {
      ...invoice.extraction,
      warnings: invoice.extraction.warnings.map(maskText),
    },
  };
}
