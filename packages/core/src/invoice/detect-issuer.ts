export type IssuerCandidate = {
  id: string;
  slug: string;
  displayName: string;
  cnpj: string | null;
  aliases: string[];
};

export type IssuerMatch =
  | { issuerId: string; confidence: number; matchedOn: "cnpj" | "alias" | "name" }
  | { issuerId: null; confidence: 0; matchedOn: "none" };

/** The letterhead is at the top. Text past this is body, not identity. */
const HEADER_CHARS = 2000;

const NO_MATCH: IssuerMatch = { issuerId: null, confidence: 0, matchedOn: "none" };

function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = fold(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

/**
 * Identifies the issuer from the document's letterhead, before any model
 * call (RF-105).
 *
 * The CNPJ decides whenever it is present, because it is the one signal a
 * marketing mention cannot fake — a Claro CNPJ on a page that also says
 * "Vivo" is a Claro invoice mentioning a competitor, not the reverse.
 *
 * When no CNPJ resolves it and more than one issuer's alias appears, the
 * answer is `unknown`. RF-106 says an unknown issuer still produces a
 * report under generic rules, and that is strictly better than a wrong
 * issuer, which in E2 would hand the invoice the wrong issuer-specific
 * rules and outrank the generic ones (RF-123).
 */
export function detectIssuer(text: string, candidates: IssuerCandidate[]): IssuerMatch {
  const header = text.slice(0, HEADER_CHARS);
  const folded = fold(header);
  const headerDigits = digitsOnly(header);

  for (const candidate of candidates) {
    if (candidate.cnpj && headerDigits.includes(candidate.cnpj)) {
      return { issuerId: candidate.id, confidence: 0.99, matchedOn: "cnpj" };
    }
  }

  const byAlias = candidates.filter((candidate) =>
    [candidate.displayName, ...candidate.aliases].some((alias) =>
      containsWord(folded, alias),
    ),
  );

  if (byAlias.length === 1) {
    const only = byAlias[0];
    if (!only) return NO_MATCH;
    return { issuerId: only.id, confidence: 0.75, matchedOn: "alias" };
  }

  return NO_MATCH;
}
