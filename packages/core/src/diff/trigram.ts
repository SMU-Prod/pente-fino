/**
 * Jaccard similarity between the trigram sets of two strings (RF-200's
 * fuzzy-match step), used to catch spelling variants that survive
 * `normalizeDescription` un-collapsed.
 *
 * This mirrors Postgres `pg_trgm` deliberately, not merely by convention:
 * `invoice_items` carries a `gin_trgm_ops` index on `normalized_desc`
 * (`packages/db/src/schema.ts`), so a future query can pre-filter
 * candidates in the database with the same notion of "trigram" this
 * function applies in memory. If the two disagreed, the index could hand
 * back a candidate set that does not contain what this function would
 * call a match, or the reverse.
 *
 * Trigram extraction, matching `pg_trgm`:
 * - The input is split into words on runs of non-alphanumeric characters;
 *   empty words are discarded.
 * - Each word is padded with two leading spaces and one trailing space,
 *   then every 3-character substring of the padded word is taken — a word
 *   of length `n` yields `n + 1` trigrams.
 * - The trigram set for the whole string is the union, across all words,
 *   of every word's trigrams. It is a **set**: a trigram occurring twice
 *   (within a word or across words) counts once, exactly as `pg_trgm`
 *   counts it.
 *
 * Inputs reaching this function in production have already been through
 * `normalizeDescription`, which uppercases (after stripping accents) — so
 * this function does not re-fold case itself. Folding case here too could
 * only ever disagree with the caller's own normalisation, never help it.
 */
export const TRIGRAM_THRESHOLD = 0.8;

/** A run of characters that are not ASCII letters or digits. */
const NON_ALPHANUMERIC = /[^A-Za-z0-9]+/;

/** Every 3-character substring of the padded word, in order (with repeats). */
function trigramsOfWord(word: string): string[] {
  const padded = `  ${word} `;
  const trigrams: string[] = [];
  for (let start = 0; start + 3 <= padded.length; start++) {
    trigrams.push(padded.slice(start, start + 3));
  }
  return trigrams;
}

/** The trigram set of a whole string: the union of each word's trigrams. */
function trigramSet(input: string): Set<string> {
  const words = input.split(NON_ALPHANUMERIC).filter((word) => word.length > 0);
  const set = new Set<string>();
  for (const word of words) {
    for (const trigram of trigramsOfWord(word)) {
      set.add(trigram);
    }
  }
  return set;
}

/**
 * Jaccard similarity `|A ∩ B| / |A ∪ B|` over the trigram sets of `a` and
 * `b`, in `[0, 1]`. Deterministic and symmetric.
 *
 * Two empty inputs return `0`, not `1`: an empty description carries no
 * evidence that two lines describe the same charge, so it must not be
 * scored as a perfect match.
 */
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigramSet(a);
  const setB = trigramSet(b);

  let intersectionSize = 0;
  for (const trigram of setA) {
    if (setB.has(trigram)) intersectionSize++;
  }
  const unionSize = setA.size + setB.size - intersectionSize;

  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}
