import { evaluateExpression } from "./expression.js";
import { computeDoubledCents, operatorPhrase } from "./shared.js";
import type { Finding } from "../finding.js";
import type { Evaluator } from "./types.js";

function compare(value: number, operator: ">" | "<" | ">=" | "<=", target: number): boolean {
  switch (operator) {
    case ">":
      return value > target;
    case "<":
      return value < target;
    case ">=":
      return value >= target;
    case "<=":
      return value <= target;
  }
}

/**
 * `threshold`: evaluates `spec.expr` (see `expression.ts` for the language
 * and why it exists) and compares the result to `spec.value` via
 * `spec.operator`. Produces at most one whole-invoice finding (`itemId:
 * null`, matching the PRD's "null = achado de fatura inteira").
 *
 * If `spec.expr` references a field the invoice does not carry (a card
 * invoice has no `tariffs`, an expected section is simply absent this
 * cycle), `evaluateExpression` returns `undefined` and this evaluator
 * produces no finding - never a guess. A structurally invalid expression
 * (unknown field/function name, bad syntax) throws instead: that is a
 * defect in the rule itself, true on every invoice it will ever run
 * against, so it should be caught once rather than silently producing
 * nothing forever (see `expression.ts`'s doc comment).
 *
 * `amountCents` is `Math.round(Math.abs(value))` - correct when `expr` is
 * written to evaluate to a cents amount (RN-001, RN-007, RN-011's shapes
 * all are), but not meaningful when `expr` evaluates to a dimensionless
 * count or ratio (RN-010's `sectionCount(...)`, or a percentage like
 * RN-001's fine cap). This is a known rough edge of a single generic
 * numeric evaluator with no unit information of its own; a rule whose
 * "amount at stake" differs from what `expr` computes needs that resolved
 * at the point it is seeded, not inside this evaluator.
 */
export const threshold: Evaluator = (rule, ctx) => {
  if (rule.spec.kind !== "threshold") {
    throw new Error(`threshold evaluator received a "${rule.spec.kind}" rule (${rule.slug}@${rule.version})`);
  }
  const spec = rule.spec;

  const value = evaluateExpression(spec.expr, ctx);
  if (value === undefined) return [];
  if (!compare(value, spec.operator, spec.value)) return [];

  const amountCents = Math.round(Math.abs(value));

  return [
    {
      ruleSlug: rule.slug,
      ruleVersion: rule.version,
      itemId: null,
      amountCents,
      doubledCents: computeDoubledCents(amountCents, rule.legalBasis),
      confidence: rule.confidenceBase,
      evidence: [
        `O valor avaliado nesta fatura ficou ${operatorPhrase(spec.operator)} ${spec.value} — para você verificar.`,
      ],
      legalBasis: rule.legalBasis,
      shadow: rule.shadow,
    } satisfies Finding,
  ];
};
