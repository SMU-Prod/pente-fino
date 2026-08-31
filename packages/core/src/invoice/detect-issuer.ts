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

function containsWord(haystack: string, needle: string): boolean {
  const escaped = fold(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

/**
 * Builds a regex that matches a candidate's CNPJ as a standalone run of
 * digits in the original (unfolded) header text.
 *
 * A CNPJ is printed in fixed 2-3-3-4-2 digit groups, optionally joined by
 * the punctuation Brazilian invoices actually use for it - dots, a
 * slash, a hyphen, or plain spaces - and nothing else. The match is
 * bounded by `(?<!\d)` / `(?!\d)` so it can never resolve to a
 * fourteen-digit window inside a longer run of digits: two unrelated
 * numeric fields (an invoice number, a barcode fragment) that happen to
 * sit near each other must not concatenate into a false CNPJ hit.
 *
 * The separator class deliberately excludes newlines. A page or column
 * wrap that splits a CNPJ across two lines is treated as a miss
 * (resolves to `unknown` under RF-106), not a match - allowing a line
 * break to join the pattern would reopen the exact false-positive class
 * this function exists to close, since a line break is also what
 * ordinarily separates two unrelated fields (an invoice number ending
 * one line, a phone number starting the next).
 */
function cnpjPattern(cnpj: string): RegExp {
  const groups = [cnpj.slice(0, 2), cnpj.slice(2, 5), cnpj.slice(5, 8), cnpj.slice(8, 12), cnpj.slice(12, 14)];
  const sep = "[ \\t./-]*";
  return new RegExp(`(?<!\\d)${groups.join(sep)}(?!\\d)`);
}

function containsCnpj(header: string, cnpj: string): boolean {
  return cnpjPattern(cnpj).test(header);
}

/**
 * Identifies the issuer from the document's letterhead, before any model
 * call (RF-105).
 *
 * The CNPJ decides whenever it is present, because it is the one signal a
 * marketing mention cannot fake — a Claro CNPJ on a page that also says
 * "Vivo" is a Claro invoice mentioning a competitor, not the reverse. The
 * CNPJ must appear as a contiguous, standalone digit run (see
 * `cnpjPattern`) — a candidate is not credited just because its digits
 * happen to be present somewhere in the header, since two unrelated
 * numeric fields can otherwise concatenate into a valid-looking CNPJ by
 * coincidence.
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

  for (const candidate of candidates) {
    if (candidate.cnpj && containsCnpj(header, candidate.cnpj)) {
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
