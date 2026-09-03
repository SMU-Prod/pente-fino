import type { Category } from "../invoice/canonical.js";
import { assertSafePattern, UnsafePatternError } from "./evaluators/safe-regex.js";
import { findSensitiveTerm, stringsIn } from "./sensitive.js";
import { LEGAL_REF_EFFECTS, type LegalRef, type RuleKind, type RuleSpec } from "./spec.js";

export type RuleDraftInput = {
  slug: string;
  category: Category;
  issuerId: string | null;
  kind: RuleKind;
  spec: RuleSpec;
  legalBasis: LegalRef[];
  confidenceBase: number;
  author: string;
  reason: string;
};

export type RuleDraftProblem = { field: string; code: string; message: string };

export type RuleDraftValidation = { ok: true } | { ok: false; problems: RuleDraftProblem[] };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 64;
const REASON_MAX_LENGTH = 500;

/**
 * Runs `assertSafePattern` on one `spec.match`/`spec.notMatch` string and,
 * if it throws, turns the caught `UnsafePatternError` into a `RuleDraftProblem`
 * instead of letting it escape `validateRuleDraft`.
 *
 * Global constraint 2 requires every string a human sees to be pt-BR, so the
 * `message` here is a fixed pt-BR sentence naming the field — not a copy of
 * `UnsafePatternError.message`, which is English prose meant for a developer
 * reading a stack trace, not an admin filling in a form.
 */
function pushUnsafePatternProblem(problems: RuleDraftProblem[], field: "spec.match" | "spec.notMatch", source: string): void {
  try {
    assertSafePattern(source);
  } catch (error) {
    if (!(error instanceof UnsafePatternError)) throw error;
    problems.push({
      field,
      code: "unsafe_pattern",
      message: `O padrão em "${field}" é inseguro (risco de backtracking catastrófico ou tamanho excessivo) e não pode ser salvo.`,
    });
  }
}

// --- Structural predicates ---------------------------------------------
//
// `RuleDraftInput` types `spec: RuleSpec` and `legalBasis: LegalRef[]`, so at
// the type level a caller's value already "is" one. But every real caller of
// this function (the route handler in `apps/web/app/api/admin/rules/route.ts`)
// hands it data parsed from an HTTP body through a zod schema that only
// checks `spec`'s *shape* ("an object with a string `kind`"), never its
// *meaning* — the cast from that loosely-parsed body to `RuleDraftInput` is
// an assertion nobody has actually checked by the time it reaches here. The
// predicates below treat every field as `unknown` for exactly that reason:
// a missing or wrong-typed field is not a type error at compile time, it is
// a `RuleDraftProblem` an admin needs to see, or — if left unchecked — a
// crash the first time something downstream (`assertSafePattern`, the rule
// evaluator) assumes the type was telling the truth.

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

/**
 * Structurally validates `spec` against the exact field list `RuleSpec`
 * (`spec.ts`) declares for its own `kind` — required fields present, correct
 * primitive types, enum-valued fields limited to their declared literals,
 * arrays actually arrays. Runs regardless of whether `input.kind` agrees
 * with `spec.kind` (check 2 already reports that mismatch on its own); this
 * switches on `spec.kind` itself so a caller who defeats check 2 still gets
 * every problem `spec`'s actual shape has.
 *
 * Returns whether `spec.match` and `spec.notMatch` (when `spec.kind ===
 * "pattern"`) are themselves valid strings, so the caller knows whether it
 * is safe to hand them to `assertSafePattern` — a non-string or missing
 * `match` must never reach it (see that function's `source.length` access),
 * so this check has to run, and be consulted, before check 6 does.
 */
function validateSpecStructure(spec: RuleSpec, problems: RuleDraftProblem[]): { matchOk: boolean; notMatchOk: boolean } {
  switch (spec.kind) {
    case "pattern": {
      const matchOk = isNonEmptyString(spec.match);
      if (!matchOk) {
        problems.push({
          field: "spec.match",
          code: "spec_match_required",
          message: 'O campo "spec.match" é obrigatório e deve ser uma string não vazia.',
        });
      }
      if (spec.sections !== undefined && !isStringArray(spec.sections)) {
        problems.push({
          field: "spec.sections",
          code: "spec_sections_invalid",
          message: 'O campo "spec.sections", quando presente, deve ser uma lista de strings.',
        });
      }
      const notMatchOk = spec.notMatch === undefined || typeof spec.notMatch === "string";
      if (!notMatchOk) {
        problems.push({
          field: "spec.notMatch",
          code: "spec_notMatch_invalid",
          message: 'O campo "spec.notMatch", quando presente, deve ser uma string.',
        });
      }
      if (spec.valueRange !== undefined && !isNumberPair(spec.valueRange)) {
        problems.push({
          field: "spec.valueRange",
          code: "spec_valueRange_invalid",
          message: 'O campo "spec.valueRange", quando presente, deve ser um par de números [mínimo, máximo].',
        });
      }
      if (spec.requireRecurrence !== undefined && !isFiniteNumber(spec.requireRecurrence)) {
        problems.push({
          field: "spec.requireRecurrence",
          code: "spec_requireRecurrence_invalid",
          message: 'O campo "spec.requireRecurrence", quando presente, deve ser um número.',
        });
      }
      return { matchOk, notMatchOk };
    }

    case "delta": {
      if (!isOneOf(spec.field, ["item_present", "amount", "section_total"] as const)) {
        problems.push({
          field: "spec.field",
          code: "spec_field_invalid",
          message: 'O campo "spec.field" deve ser um dos valores: "item_present", "amount" ou "section_total".',
        });
      }
      if (spec.comparedTo !== "previous_invoice") {
        problems.push({
          field: "spec.comparedTo",
          code: "spec_comparedTo_invalid",
          message: 'O campo "spec.comparedTo" deve ser exatamente "previous_invoice".',
        });
      }
      if (spec.changeAtLeastPct !== undefined && !isFiniteNumber(spec.changeAtLeastPct)) {
        problems.push({
          field: "spec.changeAtLeastPct",
          code: "spec_changeAtLeastPct_invalid",
          message: 'O campo "spec.changeAtLeastPct", quando presente, deve ser um número.',
        });
      }
      return { matchOk: true, notMatchOk: true };
    }

    case "threshold": {
      if (!isNonEmptyString(spec.expr)) {
        problems.push({
          field: "spec.expr",
          code: "spec_expr_required",
          message: 'O campo "spec.expr" é obrigatório e deve ser uma string não vazia.',
        });
      }
      if (!isOneOf(spec.operator, [">", "<", ">=", "<="] as const)) {
        problems.push({
          field: "spec.operator",
          code: "spec_operator_invalid",
          message: 'O campo "spec.operator" deve ser um dos valores: ">", "<", ">=" ou "<=".',
        });
      }
      if (!isFiniteNumber(spec.value)) {
        problems.push({
          field: "spec.value",
          code: "spec_value_invalid",
          message: 'O campo "spec.value" é obrigatório e deve ser um número.',
        });
      }
      return { matchOk: true, notMatchOk: true };
    }

    case "reference": {
      if (!isOneOf(spec.source, ["aneel_tariff", "aneel_flag", "cdc_limits"] as const)) {
        problems.push({
          field: "spec.source",
          code: "spec_source_invalid",
          message: 'O campo "spec.source" deve ser um dos valores: "aneel_tariff", "aneel_flag" ou "cdc_limits".',
        });
      }
      if (!isFiniteNumber(spec.tolerancePct)) {
        problems.push({
          field: "spec.tolerancePct",
          code: "spec_tolerancePct_invalid",
          message: 'O campo "spec.tolerancePct" é obrigatório e deve ser um número.',
        });
      }
      return { matchOk: true, notMatchOk: true };
    }

    case "confirm": {
      if (!isNonEmptyString(spec.question)) {
        problems.push({
          field: "spec.question",
          code: "spec_question_required",
          message: 'O campo "spec.question" é obrigatório e deve ser uma string não vazia.',
        });
      }
      if (!isStringArray(spec.options)) {
        problems.push({
          field: "spec.options",
          code: "spec_options_invalid",
          message: 'O campo "spec.options" deve ser uma lista de strings.',
        });
      }
      if (spec.onNo !== "create_finding") {
        problems.push({
          field: "spec.onNo",
          code: "spec_onNo_invalid",
          message: 'O campo "spec.onNo" deve ser exatamente "create_finding".',
        });
      }
      return { matchOk: true, notMatchOk: true };
    }

    case "arithmetic": {
      if (!isNonEmptyString(spec.formula)) {
        problems.push({
          field: "spec.formula",
          code: "spec_formula_required",
          message: 'O campo "spec.formula" é obrigatório e deve ser uma string não vazia.',
        });
      }
      if (!isNonEmptyString(spec.expect)) {
        problems.push({
          field: "spec.expect",
          code: "spec_expect_required",
          message: 'O campo "spec.expect" é obrigatório e deve ser uma string não vazia.',
        });
      }
      if (!isFiniteNumber(spec.tolerancePct)) {
        problems.push({
          field: "spec.tolerancePct",
          code: "spec_tolerancePct_invalid",
          message: 'O campo "spec.tolerancePct" é obrigatório e deve ser um número.',
        });
      }
      return { matchOk: true, notMatchOk: true };
    }

    case "suppressor": {
      if (!isStringArray(spec.blocks)) {
        problems.push({
          field: "spec.blocks",
          code: "spec_blocks_invalid",
          message: 'O campo "spec.blocks" deve ser uma lista de strings.',
        });
      }
      if (!isNonEmptyString(spec.reason)) {
        problems.push({
          field: "spec.reason",
          code: "spec_reason_required",
          message: 'O campo "spec.reason" é obrigatório e deve ser uma string não vazia.',
        });
      }
      return { matchOk: true, notMatchOk: true };
    }
  }
}

/**
 * Validates one `LegalRef` entry from `legalBasis`: `effect` against
 * `LEGAL_REF_EFFECTS` (`spec.ts`'s own runtime mirror of the six literals
 * `LegalRef["effect"]` declares), `law` and `article` as non-empty strings.
 * `note` is free text and unchecked.
 *
 * The route (`apps/web/app/api/admin/rules/route.ts`) parses `legalBasis`
 * through a zod schema that leaves `effect` a bare `z.string()` — deferring
 * exactly this check to here, the same way `spec`'s own shape is deferred —
 * so an admin who submits `effect: "alguma-coisa"` must be stopped here, or
 * it reaches `packages/core/src/documents/assemble.ts` downstream as if it
 * were one of the six known values.
 */
function validateLegalRef(ref: LegalRef, index: number, problems: RuleDraftProblem[]): void {
  if (!isNonEmptyString(ref.law)) {
    problems.push({
      field: `legalBasis[${index}].law`,
      code: "legal_basis_law_required",
      message: `O campo "law" da referência legal ${index + 1} é obrigatório e deve ser uma string não vazia.`,
    });
  }
  if (!isNonEmptyString(ref.article)) {
    problems.push({
      field: `legalBasis[${index}].article`,
      code: "legal_basis_article_required",
      message: `O campo "article" da referência legal ${index + 1} é obrigatório e deve ser uma string não vazia.`,
    });
  }
  if (!isOneOf(ref.effect, LEGAL_REF_EFFECTS)) {
    problems.push({
      field: `legalBasis[${index}].effect`,
      code: "legal_basis_effect_invalid",
      message:
        `O campo "effect" da referência legal ${index + 1} deve ser um dos valores: ` +
        `${LEGAL_REF_EFFECTS.map((effect) => `"${effect}"`).join(", ")}.`,
    });
  }
}

/**
 * The one gate every admin-authored `rules` row must pass before it becomes
 * an INSERT (RF-301's CRUD, ADR-06's "regras declarativas em banco"). A row
 * written from a form is unreviewed configuration — nobody reads a diff of
 * it before it starts running against real invoices — so this function is
 * where the three things that must be impossible to type in actually get
 * rejected: a catastrophically-backtracking regex (`assertSafePattern`,
 * whose own doc comment names this admin panel as its threat model), a
 * sensitive-category term (INV-006, via `findSensitiveTerm` — moved here
 * from a test file precisely so a production write path can see it too),
 * and a `kind` that disagrees with `spec.kind`.
 *
 * **`input`'s type is not proof the data is valid.** `spec: RuleSpec` and
 * `legalBasis: LegalRef[]` are what the type declares, but this function's
 * real callers (the route handler, ultimately) hand it data cast from a
 * parsed HTTP body whose shape a zod schema only checked loosely at the
 * edge — the type here is an assertion nobody has actually verified. That is
 * exactly why `validateSpecStructure` and `validateLegalRef` below exist:
 * do not delete them as "redundant with the type system", because the type
 * system is not the thing standing between a malformed body and a database
 * row.
 *
 * Every check runs regardless of whether an earlier one already failed —
 * an admin fixing a form one round-trip per error is a worse product than
 * one who sees the whole list of problems at once — so callers always get
 * back either `{ ok: true }` or every `RuleDraftProblem` found, never just
 * the first.
 */
export function validateRuleDraft(input: RuleDraftInput): RuleDraftValidation {
  const problems: RuleDraftProblem[] = [];

  // 1. slug shape
  if (!SLUG_PATTERN.test(input.slug)) {
    problems.push({
      field: "slug",
      code: "slug_invalid_format",
      message:
        'Slug deve conter apenas letras minúsculas, números e hífens simples entre eles (ex.: "gasto-farmacia-recorrente").',
    });
  }
  if (input.slug.length < SLUG_MIN_LENGTH || input.slug.length > SLUG_MAX_LENGTH) {
    problems.push({
      field: "slug",
      code: "slug_invalid_length",
      message: `Slug deve ter entre ${SLUG_MIN_LENGTH} e ${SLUG_MAX_LENGTH} caracteres.`,
    });
  }

  // 2. kind must agree with spec.kind
  if (input.kind !== input.spec.kind) {
    problems.push({
      field: "kind",
      code: "kind_spec_mismatch",
      message: `O tipo da regra ("${input.kind}") não corresponde ao tipo do spec ("${input.spec.kind}").`,
    });
  }

  // 3. confidenceBase range
  if (!Number.isFinite(input.confidenceBase) || input.confidenceBase <= 0 || input.confidenceBase > 1) {
    problems.push({
      field: "confidenceBase",
      code: "confidence_base_out_of_range",
      message: "confidenceBase deve ser um número finito maior que 0 e menor ou igual a 1.",
    });
  }

  // 4. author and reason
  if (input.author.trim().length === 0) {
    problems.push({ field: "author", code: "author_required", message: "Autor é obrigatório." });
  }
  if (input.reason.trim().length === 0) {
    problems.push({ field: "reason", code: "reason_required", message: "Motivo é obrigatório." });
  } else if (input.reason.length > REASON_MAX_LENGTH) {
    problems.push({
      field: "reason",
      code: "reason_too_long",
      message: `Motivo deve ter no máximo ${REASON_MAX_LENGTH} caracteres.`,
    });
  }

  // 5. spec structural validation — every one of the seven `RuleSpec` kinds,
  // not just "pattern": required fields present, correct primitive types,
  // enum-valued fields limited to their declared literals, arrays actually
  // arrays. Must run before check 6 so a missing or non-string `match`
  // becomes a `RuleDraftProblem` here, never a `TypeError` thrown out of
  // `assertSafePattern`.
  const { matchOk, notMatchOk } = validateSpecStructure(input.spec, problems);

  // 6. assertSafePattern on spec.match / spec.notMatch — only defined for
  // "pattern", and only run on a field check 5 already confirmed is a real
  // string; a `match`/`notMatch` that failed check 5 already has its own
  // problem and must not also be handed to a regex-safety scanner expecting
  // a string.
  if (input.spec.kind === "pattern") {
    if (matchOk) pushUnsafePatternProblem(problems, "spec.match", input.spec.match);
    if (input.spec.notMatch !== undefined && notMatchOk) {
      pushUnsafePatternProblem(problems, "spec.notMatch", input.spec.notMatch);
    }
  }

  // 7. INV-006 — never let a sensitive-category term into a rule. Same text
  // the DB invariant scans: slug, reason, every string inside spec, every
  // string inside legalBasis. Deliberately NOT author (a person's name).
  const scannedText = [input.slug, input.reason, ...stringsIn(input.spec), ...stringsIn(input.legalBasis)].join(
    "\n",
  );
  const sensitiveTerm = findSensitiveTerm(scannedText);
  if (sensitiveTerm !== null) {
    problems.push({
      field: "content",
      code: "sensitive_term",
      message: `O termo "${sensitiveTerm}" corresponde a uma categoria sensível (saúde, religião, sindicato ou política, INV-006) e não pode ser usado em uma regra.`,
    });
  }

  // 8. RF-129 — every rule needs at least one legal reference, except a
  // suppressor: `LegalRef.effect` has no value that can honestly describe a
  // thesis settled *against* the consumer (see suppressors.ts's own doc
  // comment), so a suppressor's citations live in `spec.reason`/`reason`
  // as free text instead.
  if (input.kind !== "suppressor" && input.legalBasis.length < 1) {
    problems.push({
      field: "legalBasis",
      code: "legal_basis_required",
      message: "legalBasis deve conter ao menos uma referência legal (não se aplica a regras do tipo supressor).",
    });
  }

  // 9. LegalRef structural validation — every entry, whether or not check 8
  // required one to exist at all (a suppressor can have zero, in which case
  // this loop simply does nothing).
  input.legalBasis.forEach((ref, index) => validateLegalRef(ref, index, problems));

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
