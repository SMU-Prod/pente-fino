import { normalizeDescription } from "../../invoice/normalize.js";
import type { ActiveRule } from "../engine.js";
import type { Finding } from "../finding.js";
import type { EvaluationContext } from "./types.js";

/**
 * `confirm` turns an uncertain match into a question rather than an
 * accusation - RF-124's mechanism, and the reason a low-confidence match
 * never becomes a claim on its own. When `ctx.answers` already carries the
 * user's answer, `spec.onNo` decides whether a finding is created;
 * unanswered, it produces a finding carrying `askUser` instead (RF-124
 * decides downstream whether/how that question is shown).
 *
 * ## Answer keying
 *
 * `RuleEngineInput.answers` (and therefore `ctx.answers`) is a flat
 * `Record<string, string>` with no documented convention - a real gap,
 * since the same rule could in principle be asked once per item and two
 * answers would otherwise collide under one key. This evaluator keys an
 * answer as `` `${rule.slug}@${rule.version}:${itemId ?? "invoice"}` ``:
 * slug+version so unrelated rules, or two versions of the same slug,
 * never share an answer; the item (or the literal string `"invoice"`)
 * so the same rule asked about two different items does not collide.
 *
 * Today every `confirm` finding this evaluator produces has `itemId:
 * null` - `RuleSpec`'s `confirm` kind has no field to target a specific
 * item (unlike `pattern`'s `sections`/`match`), so a confirm question is
 * necessarily invoice-scoped for now. The keying scheme still takes an
 * item id so it is ready for a future `confirm` variant that does target
 * one, without changing the key format retroactively.
 *
 * ## Deciding "no"
 *
 * `spec.options` is free-form pt-BR text, and `onNo` names only the
 * outcome ("create_finding"), not which option means "no". This
 * evaluator recognises a decline as an answer that is, case- and
 * accent-insensitively, the word "não" - every `confirm` rule must
 * therefore phrase its question so a "Não" answer means the user disputes
 * the charge (e.g. "Esta cobrança está correta?", never "Você reconhece
 * o problema?", which would invert the meaning of a "não").
 */
export function confirm(rule: ActiveRule, ctx: EvaluationContext): Finding[] {
  if (rule.spec.kind !== "confirm") return [];
  const { spec } = rule;
  const itemId: string | null = null; // no field on `RuleSpec`'s confirm kind to target an item
  const key = confirmAnswerKey(rule, itemId);
  const answer = ctx.answers[key];

  if (answer === undefined) {
    return [
      buildFinding(rule, itemId, {
        evidence: [`Para avaliar esta cobrança, precisamos que você responda: "${spec.question}"`],
        askUser: { question: spec.question, options: spec.options },
      }),
    ];
  }

  if (!isDecline(answer)) return [];

  // `onNo` is a single-literal union today ("create_finding"); the switch
  // is written to stay exhaustive if a second outcome is ever added.
  switch (spec.onNo) {
    case "create_finding":
      return [
        buildFinding(rule, itemId, {
          evidence: [
            `Você respondeu que não confirma esta cobrança ("${spec.question}") - para você verificar.`,
          ],
        }),
      ];
  }
}

/**
 * The key an answer to `rule`'s question is stored under in
 * `ctx.answers`, scoped by the item it concerns when there is one. See
 * the module doc comment for why this shape was chosen.
 */
export function confirmAnswerKey(rule: ActiveRule, itemId: string | null): string {
  return `${rule.slug}@${rule.version}:${itemId ?? "invoice"}`;
}

/**
 * Reuses `normalizeDescription`'s accent-stripping/uppercasing (RF-122)
 * instead of duplicating it: a bare answer like "não" or "Nao" is exactly
 * the shape that function already normalises correctly, and a single word
 * has none of its numeric-token caveats to worry about.
 */
function isDecline(answer: string): boolean {
  return normalizeDescription(answer) === "NAO";
}

function buildFinding(
  rule: ActiveRule,
  itemId: string | null,
  extra: { evidence: string[]; askUser?: { question: string; options: string[] } },
): Finding {
  return {
    ruleSlug: rule.slug,
    ruleVersion: rule.version,
    itemId,
    amountCents: 0,
    doubledCents: null,
    confidence: rule.confidenceBase,
    evidence: extra.evidence,
    legalBasis: rule.legalBasis,
    shadow: rule.shadow,
    ...(extra.askUser === undefined ? {} : { askUser: extra.askUser }),
  };
}
