import { normalizeDescription } from "../../invoice/normalize.js";
import { computeDoubledCents, formatCentsBRL } from "./shared.js";
import type { Finding } from "../finding.js";
import type { Evaluator } from "./types.js";

/**
 * `pattern` (RN-020's shape): an item whose normalised description matches
 * `spec.match`, optionally restricted to `spec.sections`, excluding
 * `spec.notMatch`, honouring `spec.valueRange` and `spec.requireRecurrence`.
 *
 * ## Matching
 *
 * `spec.match` / `spec.notMatch` are `RegExp` source strings evaluated
 * against `normalizeDescription(item.description)` (RF-122) - the already
 * upper-cased, accent-stripped, number-stripped form - never the raw text.
 * `notMatch` excludes an item even when `match` also matched it.
 *
 * ## `valueRange` is inclusive on both ends (deliberate decision)
 *
 * An item priced at exactly `min` or exactly `max` counts. The PRD phrases
 * ranges in prose as "between X and Y", and inclusive bounds mean a rule
 * author who knows an SVA always bills an exact price (e.g. R$9,90) does
 * not have to fudge the boundary by one cent to catch it.
 *
 * ## `requireRecurrence` only ever looks one cycle back
 *
 * `EvaluationContext` carries at most one previous invoice, never a full
 * history (see `types.ts`). So regardless of the configured number, this
 * evaluator can only check "does the same normalised description also
 * appear on the immediately previous invoice" - any `requireRecurrence >=
 * 1` means exactly that, not "N cycles". With no previous invoice at all,
 * the rule produces nothing rather than assuming recurrence: never turn a
 * missing fact into an accusation.
 *
 * ## `itemId` is always `null` here
 *
 * `Finding.itemId` is meant to point at a persisted `invoice_items` row,
 * but `InvoiceCanonical`'s items (see `invoice/canonical.ts`) carry no id -
 * this package does no I/O and never sees the database's generated keys.
 * Mapping a finding back to a concrete row is deferred to the persistence
 * layer (packages/db), which has the real id and can re-derive it from the
 * same item data this evaluator already read.
 *
 * ## RF-129
 *
 * `evidence` and `legalBasis` are built from data the rule and the matched
 * item actually carry - the item's own description and amount, and the
 * rule's own `legalBasis` - never invented. The wording follows §14.2's
 * approved phrasing ("para você verificar") and is fixed in this file
 * rather than admin-authored, so it cannot drift from the vocabulary the
 * `packages/ai` lint enforces elsewhere.
 */
export const pattern: Evaluator = (rule, ctx) => {
  if (rule.spec.kind !== "pattern") {
    throw new Error(`pattern evaluator received a "${rule.spec.kind}" rule (${rule.slug}@${rule.version})`);
  }
  const spec = rule.spec;

  const matchRe = new RegExp(spec.match);
  const notMatchRe = spec.notMatch === undefined ? null : new RegExp(spec.notMatch);

  const previousDescriptions =
    ctx.previous === null
      ? null
      : new Set(
          ctx.previous.sections.flatMap((section) =>
            section.items.map((item) => normalizeDescription(item.description)),
          ),
        );

  const findings: Finding[] = [];

  for (const section of ctx.invoice.sections) {
    if (spec.sections !== undefined && !spec.sections.includes(section.name)) {
      continue;
    }

    for (const item of section.items) {
      const normalized = normalizeDescription(item.description);
      if (!matchRe.test(normalized)) continue;
      if (notMatchRe !== null && notMatchRe.test(normalized)) continue;

      if (spec.valueRange !== undefined) {
        const [min, max] = spec.valueRange;
        if (item.amountCents < min || item.amountCents > max) continue;
      }

      if (spec.requireRecurrence !== undefined && spec.requireRecurrence >= 1) {
        if (previousDescriptions === null || !previousDescriptions.has(normalized)) continue;
      }

      findings.push({
        ruleSlug: rule.slug,
        ruleVersion: rule.version,
        itemId: null,
        amountCents: item.amountCents,
        doubledCents: computeDoubledCents(item.amountCents, rule.legalBasis),
        confidence: rule.confidenceBase,
        evidence: [`${item.description} — ${formatCentsBRL(item.amountCents)} para você verificar.`],
        legalBasis: rule.legalBasis,
        shadow: rule.shadow,
      });
    }
  }

  return findings;
};
