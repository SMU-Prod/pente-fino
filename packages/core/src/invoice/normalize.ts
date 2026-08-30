/**
 * Normalises an invoice line description so the same recurring item matches
 * across issuers and billing cycles (RF-122).
 *
 * ## Definition of a "variable number"
 *
 * RF-122 only says "remoção de números variáveis" without defining what
 * makes a number variable. This is the definition this function implements,
 * written down here so nobody has to reverse-engineer it from the regexes
 * below. A number is variable - and therefore removed - when it is either:
 *
 * 1. Date- or cycle-shaped: **exactly two** digit groups joined by a single
 *    "/", "." or "-", where **at least one of the two groups is exactly
 *    four digits** (the year). "01/2026", "07-2026" and "2026.07" are
 *    variable this way. A chain of three or more groups is never
 *    date-shaped, no matter how many of its groups happen to be four
 *    digits long - "2026-08-000123" has a four-digit first group but three
 *    groups total, so it does not qualify. This is deliberately narrower
 *    than "any digit group joined to another digit group": that looser
 *    shape also matches an installment code ("3-6"), an equipment
 *    reference ("123-456") or a postal code ("01310-100"), none of which
 *    carry a year and none of which should be treated as a cycle
 *    reference. Anchoring on a four-digit group is what tells a real date
 *    or cycle apart from those.
 * 2. Standalone: a digit run with no letter adjacent on either side, once
 *    punctuation fusion (see below) has run. "07", "40041" and "30" are
 *    variable this way.
 *
 * Everything else survives - including a digit run glued to a letter by
 * punctuation, such as "4-G" or "10-GB" - because that shape is a product
 * code or a data tier, not a cycle reference.
 *
 * ## Order of operations matters
 *
 * Rule 1 (date/cycle-shaped removal) runs first, before any punctuation
 * fusion. If fusion ran first, it would glue a cycle number onto the
 * surrounding word - e.g. "Mensalidade-01/2026" would fuse into
 * "MENSALIDADE012026" - and the standalone check (rule 2) could no longer
 * see it as a bare number, since it would no longer have a letter-free
 * boundary on either side. The recurring line would then fail to match
 * itself across billing cycles, which is the entire purpose of this
 * function. Removing the cycle-shaped number before fusion keeps the two
 * rules from fighting each other.
 *
 * ## Two-group codes that are not dates
 *
 * Tightening rule 1 to "exactly two groups, one of them four digits" means
 * a two-group chain that fails that test - an installment code ("3-6"), an
 * equipment reference ("123-456"), a postal code ("01310-100") - is no
 * longer touched by rule 1. Left to fusion and the standalone rule alone,
 * most of these are still fine: once punctuation fusion joins them to an
 * adjacent letter ("RTA-123-456" -> "RTA123456", "Combo 3-6-12X" ->
 * "COMBO 3612X"), they are no longer a bare digit run and rule 2 leaves
 * them alone.
 *
 * A postal code has no such neighbour - "CEP 01310-100" has nothing but
 * whitespace on both sides of the number. Fused into one run ("01310100")
 * it would look exactly like a bare standalone number and rule 2 would
 * delete it, silently reintroducing the exact collision this whole
 * function exists to prevent (two different CEPs collapsing to the same
 * "CEP" text). So for a two-group chain that (a) is not date-shaped and
 * (b) has no letter or digit directly touching either side, this function
 * joins the two groups with a literal "Z" instead of nothing - "01310-100"
 * becomes "01310Z100". The inserted letter gives the standalone rule a
 * neighbour to see, the same way a real letter would, so the code survives
 * instead of being read as cycle noise. Groups that already sit next to a
 * letter or digit (like the equipment/installment examples above) skip
 * this step entirely and are left for the ordinary fusion rule, which
 * fuses them without the extra "Z". A three-or-more-group chain is never
 * touched by this either - it is not date-shaped, but it is also not this
 * two-group case, so it falls through unchanged (see "Known limitation").
 *
 * ## Punctuation fusion
 *
 * Once cycle/date-shaped numbers are gone (and two-group non-date codes
 * have been fused as described above), punctuation between two
 * alphanumeric characters fuses - vanishes with no space inserted -
 * whenever at least one of the two neighbours is a digit: "4.5G" (digit,
 * digit) becomes "45G", "4-G" (digit, letter) becomes "4G", and "10-GB"
 * (digit, letter) becomes "10GB", each kept distinct from the plain form it
 * could otherwise collapse into ("4G", "5G", "20-GB"). Punctuation between
 * two letters - e.g. the "(" in "ADICIONADO(SVA)" - is unaffected by fusion
 * and still becomes a space, as does punctuation anywhere else (string
 * edges, next to whitespace, etc.).
 *
 * ## Known limitation
 *
 * A standalone purely numeric token - no punctuation, no adjacent letter -
 * is always dropped by rule 2, so it is indistinguishable from a cycle
 * number: a premium short code like "40041" versus "40042", or "Multa por
 * atraso 30 dias" versus "15 dias", normalise identically. The same is true
 * of a multi-group all-numeric code with three or more groups, such as a
 * protocol number - "Protocolo 2026-08-000123" versus
 * "Protocolo 2026-08-000456" - because a chain that long is never
 * date-shaped (rule 1 requires exactly two groups) and has no letter to
 * fuse onto, so punctuation fusion reduces it to one bare digit run that
 * rule 2 then deletes like any other standalone number. This function has
 * no way to tell an identifier apart from a billing cycle without more
 * context than a string carries. Anything in E2 that matches pattern rules
 * against this output must not assume that equal normalised descriptions
 * mean the same billable item.
 */
export function normalizeDescription(input: string): string {
  return (
    input
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      // Rule 1 (date/cycle-shaped numbers) plus the two-group non-date code
      // case, both handled on the same maximal chain of digit groups so the
      // decision always sees the whole chain and never a partial slice of a
      // longer one (the original bug: unbounded backtracking ate a
      // variable-length prefix on chains of three or more groups). Must run
      // before general fusion below (see "Order of operations matters").
      .replace(/\d+(?:[\/.-]\d+)+/g, (match, offset: number, str: string) => {
        const groups = match.split(/[\/.-]/);
        if (groups.length === 2 && groups.some((group) => group.length === 4)) {
          // Exactly two groups, one of them a year: date/cycle-shaped, drop it.
          return "";
        }
        if (groups.length === 2) {
          // Exactly two groups, neither a year: a structured code (postal
          // code, equipment/installment fragment). If it already sits next
          // to a letter or digit, the ordinary fusion rule below will join
          // it correctly on its own - leave it untouched. Otherwise it has
          // nothing to fuse onto and would look like a bare number once its
          // separator is gone, so join it with a literal "Z" to keep it
          // out of rule 2's reach (see "Two-group codes that are not
          // dates").
          const before = str.charAt(offset - 1);
          const after = str.charAt(offset + match.length);
          if (/[A-Z0-9]/.test(before) || /[A-Z0-9]/.test(after)) {
            return match;
          }
          return groups.join("Z");
        }
        // Three or more groups: not date-shaped, left for the existing
        // fusion/standalone rules (see "Known limitation").
        return match;
      })
      // Fusion: punctuation between two alphanumerics vanishes (no space)
      // when at least one neighbour is a digit, so "4-G" survives as "4G"
      // and "4.5G" survives as "45G", each distinct from "5G".
      .replace(/(?<=[0-9])[^A-Z0-9\s]+(?=[A-Z0-9])|(?<=[A-Z])[^A-Z0-9\s]+(?=[0-9])/g, "")
      // Everything else non-alphanumeric becomes a space (word separator).
      .replace(/[^A-Z0-9\s]/g, " ")
      // Rule 2 (standalone numbers): digit runs with no adjacent letter.
      .replace(/(?<![A-Z0-9])\d+(?![A-Z0-9])/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}
