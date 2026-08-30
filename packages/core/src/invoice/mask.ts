import type { InvoiceCanonical, InvoiceItem } from "./canonical.js";

/**
 * Masking rules for RF-109 / INV-007. Order matters: the longest and most
 * specific patterns run first, so a digitable line is not eaten piecemeal by
 * the barcode or document-number patterns.
 *
 * CPF and CNPJ are recognised structurally, not by enumerating punctuation
 * variants: a document number is a run of digits, optionally separated by
 * `.`, `-`, `/` or a single space between any two digits, whose digit count
 * is exactly 11 (CPF) or exactly 14 (CNPJ). This is also what `containsPii`
 * tests against below, so the detector and the redactor cannot drift apart.
 */
const DOCUMENT_SEPARATOR = String.raw`[.\-/ ]?`;
const CPF_SOURCE = String.raw`\b(?:\d${DOCUMENT_SEPARATOR}){10}\d\b`;
const CNPJ_SOURCE = String.raw`\b(?:\d${DOCUMENT_SEPARATOR}){13}\d\b`;

// FEBRABAN bank-slip ("boleto bancário") digitable line: fields of
// 5+5 / 5+6 / 5+6 / 1 / 14 digits — the most common linha digitável in
// Brazil, printed on bank and card statements. Dots and the space between
// fields are both optional, so the fully contiguous 47-digit form matches
// too.
const FEBRABAN_LINE_SOURCE = String.raw`\b\d{5}\.?\d{5}\s?\d{5}\.?\d{6}\s?\d{5}\.?\d{6}\s?\d\s?\d{14}\b`;

// Convênio (arrecadação) digitable line: four 12-digit fields (11 digits +
// check digit), typically dash-separated.
const CONVENIO_LINE_SOURCE = String.raw`\b\d{11}-?\d\s+\d{11}-?\d\s+\d{11}-?\d\s+\d{11}-?\d\b`;

const BARCODE_SOURCE = String.raw`\b\d{44}\b`;

// A street-type keyword followed by text is not enough on its own to be an
// address — "Praça de Alimentação" is a food-court line item, not a
// location. It becomes an address once it is followed by a house number, by
// `s/n`, or by a CEP. Digits are allowed inside the street-name segment so
// names like "Rua 25 de Março" are not excluded from matching.
const ADDRESS_SOURCE = String.raw`\b(?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rodovia|Estrada)\b[^,;]*,\s*(?:\d+[^,;]*(?:,\s*(?:apto|ap\.?|bloco|casa)\s*\S+)?|s\/n\b|CEP\s*:?\s*\d{5}-?\d{3}\b)`;

// A CEP mentioned on its own, without a preceding street name (the address
// pattern above already handles a CEP that follows one).
const CEP_LABEL_SOURCE = String.raw`\bCEP\s*:?\s*\d{5}-?\d{3}\b`;

const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: new RegExp(FEBRABAN_LINE_SOURCE, "g"), replacement: "[LINHA_DIGITAVEL]" },
  { pattern: new RegExp(CONVENIO_LINE_SOURCE, "g"), replacement: "[LINHA_DIGITAVEL]" },
  { pattern: new RegExp(BARCODE_SOURCE, "g"), replacement: "[CODIGO_BARRAS]" },
  { pattern: new RegExp(CNPJ_SOURCE, "g"), replacement: "[CNPJ]" },
  { pattern: new RegExp(CPF_SOURCE, "g"), replacement: "[CPF]" },
  { pattern: new RegExp(ADDRESS_SOURCE, "gi"), replacement: "[ENDERECO]" },
  { pattern: new RegExp(CEP_LABEL_SOURCE, "gi"), replacement: "[CEP]" },
];

export function maskText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Non-global clones of the same patterns maskText uses, so containsPii can
// never see a different set of PII shapes than the redactor acts on. (A
// global regex carries mutable lastIndex state across `.test()` calls, which
// is why these are built as fresh non-global instances rather than reusing
// the PATTERNS regexes directly.)
const DETECTION_PATTERNS = PATTERNS.map(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace("g", "")));

export function containsPii(text: string): boolean {
  return DETECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function maskMeta(meta: NonNullable<InvoiceItem["meta"]>): NonNullable<InvoiceItem["meta"]> {
  const masked: NonNullable<InvoiceItem["meta"]> = {};
  for (const [key, value] of Object.entries(meta)) {
    masked[key] = typeof value === "string" ? maskText(value) : value;
  }
  return masked;
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
        ...(item.meta === undefined ? {} : { meta: maskMeta(item.meta) }),
      })),
    })),
    extraction: {
      ...invoice.extraction,
      warnings: invoice.extraction.warnings.map(maskText),
    },
  };
}
