import { normalizeDescription } from "../../invoice/normalize.js";
import type { ActiveRule } from "../engine.js";
import type { Finding } from "../finding.js";

/**
 * `suppressor` (RN-090..092's shape, `INV-010`): removes findings other
 * evaluators already produced, rather than producing any of its own. Its
 * signature is therefore deliberately **not** `Evaluator` from `./types.js`
 * (`(rule, ctx) => Finding[]`) - it has nothing to add to `ctx`, and the one
 * thing it needs that `Evaluator` does not carry is the findings list
 * produced so far. The engine (Task 4) is expected to:
 *
 *   1. run every non-suppressor active rule through its own evaluator,
 *      collecting every `Finding` they produce;
 *   2. call {@link applySuppressors} once, with every `active` rule whose
 *      `spec.kind === "suppressor"` and the findings from step 1;
 *   3. proceed with `result.survivors` as if `result.suppressed` never
 *      existed for display purposes, while still recording `result.suppressed`
 *      somewhere an operator can later ask "why didn't this fire" — never
 *      just discarding it.
 *
 * ## Matching: `spec.blocks` against the finding's own evidence text
 *
 * `INV-010`'s hard requirement is that a dead thesis must be caught **even
 * under a slug that names nothing about it** (a rule called
 * `energia-encargo-nao-identificado` that happens to flag "ICMS sobre TUSD"
 * must still be suppressed). That rules out matching on `ruleSlug` - the
 * whole point is not to trust the slug. It also rules out matching on
 * `legalBasis` - a rogue rule's own citation has no reason to mention the
 * dead thesis at all (it might cite CDC art. 42 for a made-up "cobrança
 * indevida", same as any other pattern rule).
 *
 * What every evaluator in this directory *does* put in front of the user,
 * regardless of `kind`, is `evidence`: a short sentence built from the
 * matched item's own description (see `pattern.ts`, `delta.ts`). That text
 * is the one place the underlying billed concept - "ICMS", "TUSD", "COSIP",
 * "poste" - survives independently of which rule or slug produced the
 * finding. So `spec.blocks` is a list of `RegExp` source strings (the same
 * convention as `pattern.ts`'s `match`/`notMatch`), tested against
 * `normalizeDescription(finding.evidence.join(" "))` - case- and
 * accent-insensitive, same as every other text match in this package
 * (RF-122). A finding is removed if **any** pattern in `blocks` matches.
 *
 * A pattern that needs "contains both X and Y, in either order" (RN-090's
 * "ICMS" together with "TUSD" or "TUST", not necessarily adjacent or in a
 * fixed order) is written with lookaheads - `"(?=.*ICMS)(?=.*TUSD)"` - the
 * same trick `expression.ts`'s callers use nowhere else in this package
 * only because nothing else has needed an unordered AND until now.
 *
 * ## Known scope limit
 *
 * This only catches a dead thesis when the firing rule's evidence text
 * actually names the billed concept - true for every `pattern`/`delta`
 * finding (both embed the item's own description) but not for a
 * `threshold`/`arithmetic` finding, whose evidence is generic formula
 * wording with no item description in it at all. A `threshold` rule could
 * in principle be written to re-derive "ICMS over TUSD" from raw invoice
 * fields without ever naming it - that shape is not caught here. RN-090..092
 * are all naturally item-description rules in practice (the PRD phrases
 * them as "a charge labelled X"), so this is not believed to leave a real
 * gap today, but it is a real edge of the mechanism, not a hidden one.
 *
 * ## Why removed findings are `SuppressedFinding`, not a `shadow: true` `Finding`
 *
 * A suppressed finding is not "a finding nobody sees yet" (that is what
 * `shadow` already means, RF-125) - it is a finding that must **never** be
 * shown, ever, to anyone, and the reason it was killed matters as much as
 * the finding itself. Folding that into `Finding` would need a new field
 * every other reader of `Finding` (persistence, the report view, RF-129's
 * evidence/legalBasis check) would have to learn to ignore. A separate,
 * narrower type keeps "what a user can see" (`Finding`) and "what the
 * engine decided never to show, and why" (`SuppressedFinding`) from ever
 * being confusable at the type level.
 */
export type SuppressedFinding = {
  finding: Finding;
  ruleSlug: string;
  ruleVersion: number;
  reason: string;
};

export type SuppressionResult = {
  survivors: Finding[];
  suppressed: SuppressedFinding[];
};

/**
 * Applies one `suppressor` rule to `findings`, returning the findings it
 * leaves standing and the ones it removed (each paired with this rule's
 * slug/version/reason - see the module doc comment for why that is
 * recorded rather than just dropping the finding).
 */
export function suppressor(rule: ActiveRule, findings: Finding[]): SuppressionResult {
  if (rule.spec.kind !== "suppressor") {
    throw new Error(`suppressor evaluator received a "${rule.spec.kind}" rule (${rule.slug}@${rule.version})`);
  }
  const { spec } = rule;
  const patterns = spec.blocks.map((source) => new RegExp(source));

  const survivors: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];

  for (const finding of findings) {
    const haystack = normalizeDescription(finding.evidence.join(" "));
    const blocked = patterns.some((re) => re.test(haystack));
    if (blocked) {
      suppressed.push({ finding, ruleSlug: rule.slug, ruleVersion: rule.version, reason: spec.reason });
    } else {
      survivors.push(finding);
    }
  }

  return { survivors, suppressed };
}

/**
 * Runs every given suppressor `rule` over `findings` in sequence - each
 * rule sees the survivors of the one before it - and accumulates every
 * removal across all of them. Order between suppressors does not change
 * the final survivor set (each one only ever removes, never restores), only
 * which suppressor gets credited for a finding matched by more than one -
 * the first one in `rules` to match it, which is an implementation detail
 * of this loop, not a documented guarantee callers should rely on.
 */
export function applySuppressors(rules: ActiveRule[], findings: Finding[]): SuppressionResult {
  let current = findings;
  const allSuppressed: SuppressedFinding[] = [];

  for (const rule of rules) {
    const { survivors, suppressed } = suppressor(rule, current);
    current = survivors;
    allSuppressed.push(...suppressed);
  }

  return { survivors: current, suppressed: allSuppressed };
}
