import type { Category } from "../invoice/canonical.js";
import { assertSafePattern, UnsafePatternError } from "./evaluators/safe-regex.js";
import { findSensitiveTerm, stringsIn } from "./sensitive.js";
import type { LegalRef, RuleKind, RuleSpec } from "./spec.js";

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

  // 5. assertSafePattern on spec.match / spec.notMatch — only defined for "pattern"
  if (input.spec.kind === "pattern") {
    pushUnsafePatternProblem(problems, "spec.match", input.spec.match);
    if (input.spec.notMatch !== undefined) {
      pushUnsafePatternProblem(problems, "spec.notMatch", input.spec.notMatch);
    }
  }

  // 6. INV-006 — never let a sensitive-category term into a rule. Same text
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

  // 7. RF-129 — every rule needs at least one legal reference, except a
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

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
