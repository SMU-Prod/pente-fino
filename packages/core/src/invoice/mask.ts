import type { InvoiceCanonical, InvoiceItem } from "./canonical.js";

/**
 * Masking rules for RF-109 / INV-007. Order matters: the longest and most
 * specific patterns run first, so a digitable line is not eaten piecemeal by
 * the barcode or document-number rules.
 *
 * A CPF or CNPJ is recognised structurally (a run of digits, optionally
 * separated by `.`, `-`, `/` or a single space between any two digits, whose
 * digit count is exactly 11 or 14) **and then verified against its real
 * check digits** (mod-11, the same algorithm Receita Federal uses). Digit
 * count alone cannot tell a document number from a phone number, a meter
 * reading, a protocol number or a monetary amount — all of those can
 * accidentally total 11 or 14 digits — but the check digits essentially
 * never validate by chance. Two guards sit around that validation:
 *
 * - a run immediately preceded by `CPF`, `CNPJ` or `CPF/MF` (with or
 *   without a colon) is masked even when it fails validation, because OCR
 *   damage to a real, labelled document number must not become a leak;
 * - a run preceded by `R$` or followed by a decimal comma and two digits is
 *   never treated as a document number, so a monetary amount is never
 *   corrupted by a coincidental 11- or 14-digit total.
 *
 * `containsPii` and `maskText` both iterate the same `RULES` array below —
 * same shape regex, same `isPii` decision function — so the detector and
 * the redactor cannot drift apart.
 *
 * Accepted limitations of E0 (deliberately not fixed here):
 *
 * 1. Person names, RG numbers and email addresses are not masked. RF-109
 *    names CPF, the holder's CNPJ, address, barcode and digitable line, and
 *    only those five are implemented. A cardholder name on a "Titular" line
 *    would survive untouched. Whether extractor output actually carries
 *    names, RG or email is a question the E1 golden set answers — revisit
 *    this list once it does.
 * 2. A digitable line written with dashes or double spaces instead of the
 *    dots/single-spaces the FEBRABAN and convênio shapes expect is not
 *    recognised as one token, so `FEBRABAN_LINE_SOURCE` /
 *    `CONVENIO_LINE_SOURCE` fail to match it as a whole. Its digits still
 *    fall through to the barcode and CPF/CNPJ rules and get masked in
 *    fragments — no PII survives — but the result is several markers
 *    instead of one clean `[LINHA_DIGITAVEL]`. Cosmetic, named here so
 *    nobody mistakes the fragmentation for a leak.
 */
const DOCUMENT_SEPARATOR = String.raw`[.\-/ ]?`;
const CPF_SOURCE = String.raw`\b(?:\d${DOCUMENT_SEPARATOR}){10}\d\b`;

/**
 * The shape of a CNPJ, as a pattern source so a caller can build its own
 * RegExp with whatever flags it needs.
 *
 * Exported because more than one place has to recognise this shape, and a
 * second hand-written copy is a defect waiting to happen: this repository
 * has already had one detector disagree with its own redactor. Shape only —
 * it says nothing about whether the digits are a valid CNPJ. For that, and
 * for deciding whether something is PII at all, use `containsPii`, which
 * checks the mod-11 check digits.
 */
export const CNPJ_SHAPE_SOURCE = String.raw`\b(?:\d${DOCUMENT_SEPARATOR}){13}\d\b`;
const CNPJ_SOURCE = CNPJ_SHAPE_SOURCE;

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

// A street-type keyword by itself is not enough to be an address — "Praça
// de Alimentação" is a food-court line item, not a location. It becomes an
// address once, somewhere after it, a house number, `s/n` or a CEP shows
// up — even past descriptive clauses ("próximo à praça central") that sit
// in between and may themselves contain another street-type keyword. The
// middle segment is intentionally lazy and comma-tolerant: it expands only
// as far as it must to reach the first qualifying terminator, so a nested
// keyword inside that span is consumed as ordinary text and never gets a
// chance to start a competing match of its own (String.replace resumes
// scanning only after the end of a match it already made).
const STREET_KEYWORD_SOURCE = String.raw`(?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rodovia|Estrada)`;
const HOUSE_NUMBER_OR_TERMINATOR_SOURCE = String.raw`,\s*(?:\d+(?:[^,;\n]*(?:,\s*(?:apto|ap\.?|bloco|casa)\s*\S+)?)?|s\/n\b|CEP\s*:?\s*\d{5}-?\d{3}\b)`;
const ADDRESS_SOURCE = String.raw`\b${STREET_KEYWORD_SOURCE}\b[^\n]*?${HOUSE_NUMBER_OR_TERMINATOR_SOURCE}`;

// A CEP mentioned on its own, without a preceding street name (the address
// pattern above already handles a CEP that follows one).
const CEP_LABEL_SOURCE = String.raw`\bCEP\s*:?\s*\d{5}-?\d{3}\b`;

// --- CPF / CNPJ check-digit validation (mod-11) --------------------------

const CPF_WEIGHTS_DV1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const CPF_WEIGHTS_DV2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function weightedCheckDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((total, digit, index) => total + digit * weights[index]!, 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const n = digits.split("").map(Number);
  const dv1 = weightedCheckDigit(n.slice(0, 9), CPF_WEIGHTS_DV1);
  if (dv1 !== n[9]) return false;
  const dv2 = weightedCheckDigit(n.slice(0, 10), CPF_WEIGHTS_DV2);
  return dv2 === n[10];
}

function isValidCnpj(digits: string): boolean {
  if (!/^\d{14}$/.test(digits)) return false;
  const n = digits.split("").map(Number);
  const dv1 = weightedCheckDigit(n.slice(0, 12), CNPJ_WEIGHTS_DV1);
  if (dv1 !== n[12]) return false;
  const dv2 = weightedCheckDigit(n.slice(0, 13), CNPJ_WEIGHTS_DV2);
  return dv2 === n[13];
}

// A document number is never inside a monetary amount: preceded by `R$`,
// or followed by a decimal comma and exactly two digits.
const MONEY_PREFIX = /R\$\s*$/i;
const MONEY_SUFFIX = /^,\d{2}(?!\d)/;

// A run immediately preceded by one of these labels is a document number
// even if OCR damage makes its check digits fail.
const DOCUMENT_LABEL = /(?:CPF\/MF|CNPJ|CPF)\s*:?\s*$/i;

type PiiDecider = (candidate: string, offset: number, full: string) => boolean;

const alwaysPii: PiiDecider = () => true;

function isDocumentNumber(validate: (digits: string) => boolean): PiiDecider {
  return (candidate, offset, full) => {
    const before = full.slice(0, offset);
    const after = full.slice(offset + candidate.length);
    if (MONEY_PREFIX.test(before) || MONEY_SUFFIX.test(after)) {
      return false;
    }
    if (DOCUMENT_LABEL.test(before)) {
      return true;
    }
    return validate(candidate.replace(/\D/g, ""));
  };
}

interface MaskRule {
  shape: RegExp;
  replacement: string;
  isPii: PiiDecider;
}

const RULES: MaskRule[] = [
  { shape: new RegExp(FEBRABAN_LINE_SOURCE, "g"), replacement: "[LINHA_DIGITAVEL]", isPii: alwaysPii },
  { shape: new RegExp(CONVENIO_LINE_SOURCE, "g"), replacement: "[LINHA_DIGITAVEL]", isPii: alwaysPii },
  { shape: new RegExp(BARCODE_SOURCE, "g"), replacement: "[CODIGO_BARRAS]", isPii: alwaysPii },
  { shape: new RegExp(CNPJ_SOURCE, "g"), replacement: "[CNPJ]", isPii: isDocumentNumber(isValidCnpj) },
  { shape: new RegExp(CPF_SOURCE, "g"), replacement: "[CPF]", isPii: isDocumentNumber(isValidCpf) },
  { shape: new RegExp(ADDRESS_SOURCE, "gi"), replacement: "[ENDERECO]", isPii: alwaysPii },
  { shape: new RegExp(CEP_LABEL_SOURCE, "gi"), replacement: "[CEP]", isPii: alwaysPii },
];

export function maskText(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.shape, (match: string, offset: number, full: string) =>
      rule.isPii(match, offset, full) ? rule.replacement : match,
    );
  }
  return out;
}

// Fresh, non-global clones of each rule's shape are used here so a scan
// never mutates (or is affected by) the lastIndex state of the regex
// instance maskText uses — while still running the exact same shape source
// and the exact same isPii decision function, so detection and redaction
// cannot disagree about what counts as PII.
export function containsPii(text: string): boolean {
  return RULES.some((rule) => {
    const shape = new RegExp(rule.shape.source, rule.shape.flags);
    let match: RegExpExecArray | null;
    while ((match = shape.exec(text)) !== null) {
      if (rule.isPii(match[0], match.index, text)) {
        return true;
      }
    }
    return false;
  });
}

function maskMeta(meta: NonNullable<InvoiceItem["meta"]>): NonNullable<InvoiceItem["meta"]> {
  const masked: NonNullable<InvoiceItem["meta"]> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") {
      masked[key] = maskText(value);
      continue;
    }
    // meta is typed string | number: a document number captured by the
    // extractor as a number (e.g. a CPF read from a numeric OCR field)
    // must go through the same detection as a string would. Only replace
    // it — with the marker string, which the schema also admits — when it
    // is actually PII; an ordinary number (a line number, a quantity)
    // passes through unchanged, keeping its numeric type.
    const stringified = String(value);
    masked[key] = containsPii(stringified) ? maskText(stringified) : value;
  }
  return masked;
}

/**
 * Returns a copy of the canonical invoice with personal data replaced by
 * markers. The issuer CNPJ survives: it identifies the company, not the
 * person, and the tariff join of RN-040 depends on it. It is never routed
 * through `maskText`.
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
