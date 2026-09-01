import { evaluateExpression } from "./expression.js";
import { computeDoubledCents } from "./shared.js";
import type { Finding } from "../finding.js";
import type { Evaluator } from "./types.js";

/**
 * `arithmetic`: evaluates `spec.formula` and `spec.expect` (see
 * `expression.ts`) and fires when they disagree by more than
 * `spec.tolerancePct` of `expect`'s magnitude - RN-004's water-reading
 * check ("current - previous should equal the billed consumption") is the
 * canonical shape.
 *
 * ## Tolerance is a percentage of `expect`, inclusive at the boundary
 *
 * `allowedDeviation = tolerancePct / 100 * abs(expect)`. A deviation
 * exactly equal to the allowed amount does **not** fire - the boundary
 * belongs to "within tolerance", mirroring `pattern`'s inclusive
 * `valueRange` decision. When `expect` is exactly zero, the allowed
 * deviation is zero too: `formula` must match it exactly. Pick tolerance
 * percentages and expected values that divide evenly in tests/config
 * (e.g. 10% of 1000) to keep the floating-point multiplication exact at
 * the boundary; this evaluator does not round the tolerance itself.
 *
 * ## Money stays in integer cents throughout
 *
 * Every quantity this module's fields resolve to (see `expression.ts`) is
 * already an integer - cents, or a whole reading - and `formula`/`expect`
 * only ever add, subtract, multiply or divide them. Nothing here divides
 * by 100 into a fractional reais amount before comparing, which is
 * exactly the step that would reintroduce classic floating-point error
 * (`0.1 + 0.2 !== 0.3`); see `arithmetic.test.ts` for a test that pins
 * this down with cent amounts chosen to reveal that mistake if it were
 * ever reintroduced.
 *
 * With either operand missing (`undefined` - see `expression.ts`'s
 * "missing data" contract), this evaluator produces no finding rather than
 * comparing against a guess.
 *
 * `amountCents` is the raw deviation, rounded - correct when both sides
 * are cents-denominated (RN-001, RN-003, RN-011's shapes), not literally
 * money when they are a physical reading (RN-004's water m³). Same
 * documented limitation as `threshold.ts`: this generic evaluator carries
 * no unit information beyond "a number".
 */
export const arithmetic: Evaluator = (rule, ctx) => {
  if (rule.spec.kind !== "arithmetic") {
    throw new Error(`arithmetic evaluator received a "${rule.spec.kind}" rule (${rule.slug}@${rule.version})`);
  }
  const spec = rule.spec;

  const formulaValue = evaluateExpression(spec.formula, ctx);
  const expectValue = evaluateExpression(spec.expect, ctx);
  if (formulaValue === undefined || expectValue === undefined) return [];

  const deviation = Math.abs(formulaValue - expectValue);
  const allowedDeviation = (spec.tolerancePct / 100) * Math.abs(expectValue);
  if (deviation <= allowedDeviation) return [];

  const amountCents = Math.round(deviation);

  return [
    {
      ruleSlug: rule.slug,
      ruleVersion: rule.version,
      itemId: null,
      amountCents,
      doubledCents: computeDoubledCents(amountCents, rule.legalBasis),
      confidence: rule.confidenceBase,
      evidence: [
        `A conta não fechou nesta fatura: a diferença encontrada ficou acima da margem de ${spec.tolerancePct}% prevista — para você verificar.`,
      ],
      legalBasis: rule.legalBasis,
      shadow: rule.shadow,
    } satisfies Finding,
  ];
};
