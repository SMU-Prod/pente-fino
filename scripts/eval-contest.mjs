#!/usr/bin/env node
// scripts/eval-contest.mjs
//
// The §20.4 eval harness for a generated contestation (PRD §20.4, E4 Task
// 5): for every case directory under fixtures/eval/contest, reads a
// generated `ContestDocument` and the `AssembledContest` baseline it was
// built from, and scores the document against the rubric —
//
//   | Critério                                                | Peso |
//   |----------------------------------------------------------|------|
//   | Contém todos os pedidos do playbook para a etapa          |  3   |
//   | Cita apenas as bases legais fornecidas                    |  3   |
//   | Zero termos da lista proibida                             |  2   |
//   | Menciona protocolos e prazos vencidos quando existirem    |  1   |
//   | Tamanho entre 200 e 4000 caracteres, tom neutro           |  1   |
//
// Approval is >= 8/10 over a sample of 20 cases per prompt version.
//
// Usage:
//   pnpm eval:contest                        # scans fixtures/eval/contest
//   node scripts/eval-contest.mjs <dir>      # scans an arbitrary directory
//
// ---------------------------------------------------------------------
// THE ONE BEHAVIOUR THAT MATTERS MOST
// ---------------------------------------------------------------------
//
// With the scanned directory empty, this reports zero cases and EXITS 0 —
// there is nothing yet to measure, and it says so loudly (mirroring
// `golden:run`/`golden:count`), rather than silently reporting success over
// a measurement of nothing. A sample only exists once Task 2's generator has
// actually produced documents, which needs `AI_GATEWAY_API_KEY`; until that
// key exists, fixtures/eval/contest stays empty and this script keeps
// saying, loudly, that §18's "eval com rubrica >= 8/10" gate for this block
// is not being measured. Faking that gate over an empty sample is exactly
// the failure mode this repo has shipped and caught before.
//
// ---------------------------------------------------------------------
// WHAT THIS HARNESS ACTUALLY MEASURES (read before extending it)
// ---------------------------------------------------------------------
//
// Of the rubric's five criteria, three are deterministic and need no model
// at all, because the exact thing they check already exists as real,
// non-generated code:
//
//   - "asks"           — `assembleContest` (packages/core) is RF-161/163's
//                         single source for a stage's playbook asks. This
//                         harness checks every one shows up, case-folded and
//                         accent-folded, somewhere in the document's
//                         user-facing text.
//   - "legalBases"      — `assembleContest` is also RF-161's single source
//                         of truth for which legal references a case may
//                         cite (from the findings that actually fired, never
//                         from the playbook's own per-stage table). This
//                         harness checks the document cites no reference
//                         outside that set — hallucination, not omission,
//                         is what §20.4's wording ("cita apenas") names.
//   - "forbiddenTerms"  — `lintUserFacingText` (packages/ai) is RF-162's
//                         actual pre-display gate for §14.3's vocabulary.
//                         This harness runs the real function, not a
//                         re-derived copy that could silently drift from it.
//
// Together these are 3 + 3 + 2 = 8 of the rubric's 10 points.
//
// The other two need either data this repo does not have yet or a model:
//
//   - "protocolsAndDeadlines" — `AssembledContest.protocols` carries a
//                         protocol number and channel per stage, but no
//                         date, so "prazo vencido" (an expired deadline) is
//                         not computable from it. Once a recorded protocol
//                         carries a date, the "mentions the protocol number"
//                         half could join the deterministic set — the
//                         "expired deadline" half still could not, without
//                         also deciding what counts as a textual mention of
//                         one, which needs judgment this harness does not
//                         attempt to encode as a moving target.
//   - "lengthAndTone"        — length alone (200-4000 characters) is a
//                         trivial check, but the rubric line bundles it with
//                         "tom neutro" (neutral tone) into one weighted
//                         criterion, and tone needs a model's or a human's
//                         judgment. Scoring only the length half and calling
//                         the criterion satisfied would silently claim more
//                         than was actually checked.
//
// Every case in the report carries an explicit, unmeasured entry for both —
// never a default "true", which would be indistinguishable from a real pass.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));

// See ts-sibling-loader.mjs's own header for exactly why this hook is
// needed here (and not by golden-run.mjs/golden-anonymize.mjs): unlike
// those two scripts' entry points, `lintUserFacingText`'s import chain has a
// real, value-level relative import that plain Node cannot resolve without
// it. Registered before the dynamic imports below run, on purpose — a
// static top-level `import` of the same modules would be hoisted and
// resolved before this line ever executes.
register("./ts-sibling-loader.mjs", import.meta.url);

const { lintUserFacingText } = await import("../packages/ai/src/lint.ts");
const { ContestDocument } = await import("../packages/core/src/documents/contest.ts");

/** §20.4, verbatim weights. */
export const RUBRIC_WEIGHTS = Object.freeze({
  asks: 3,
  legalBases: 3,
  forbiddenTerms: 2,
  protocolsAndDeadlines: 1,
  lengthAndTone: 1,
});

export const RUBRIC_MAX = 10;
export const MEASURED_MAX = RUBRIC_WEIGHTS.asks + RUBRIC_WEIGHTS.legalBases + RUBRIC_WEIGHTS.forbiddenTerms;

export const DEFAULT_SAMPLE_DIR = resolve(HERE, "..", "fixtures", "eval", "contest");

// =====================================================================
// The three deterministic criteria
// =====================================================================

// U+0300-U+036F is the Unicode "Combining Diacritical Marks" block, written
// as an escaped range (built from a string via the RegExp constructor,
// rather than a literal regex, to rule out a stray combining character ever
// surviving into this source file itself) — same choice
// `packages/ai/src/lint.ts`'s own `fold` makes, for the same reason.
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** Same accent/case/whitespace folding `packages/ai/src/lint.ts` uses, so an ask written with different accents or spacing in the generated text still matches. */
function fold(text) {
  return text.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Every string a person could actually read in the document, concatenated for a substring search. Deliberately excludes `legalRefs` — that is structured law/article data, scored on its own below, not prose an "ask" would appear inside. */
function documentText(doc) {
  return [doc.subject, doc.body, ...doc.requests, ...doc.scriptForCall, ...doc.attachmentsChecklist].join("\n");
}

/**
 * RF-161/163: every ask `assembleContest` produced for this stage must show
 * up somewhere in the document. Whole-criterion pass/fail (weight 3), not
 * partial credit per ask — the rubric names one weighted line, and a
 * document missing even one of the stage's required asks has not actually
 * done what that stage's playbook requires.
 */
export function scoreAsks(assembled, doc) {
  const haystack = fold(documentText(doc));
  const missing = assembled.asks.filter((ask) => !haystack.includes(fold(ask)));
  const passed = missing.length === 0;
  return {
    criterion: "asks",
    weight: RUBRIC_WEIGHTS.asks,
    measured: true,
    passed,
    points: passed ? RUBRIC_WEIGHTS.asks : 0,
    detail: passed
      ? `todos os ${assembled.asks.length} pedido(s) do playbook aparecem no documento`
      : `pedido(s) do playbook ausente(s) no documento: ${missing.join(" | ")}`,
  };
}

/** Same comparison key `packages/core/src/documents/assemble.ts`'s own `legalRefKey` uses for dedup, minus `effect` — `ContestDocument.legalRefs` (§7.5) carries only `law`/`article`, no `effect`. */
function legalRefKey(ref) {
  return [ref.law, ref.article].map((part) => part.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
}

/**
 * RF-161: §20.4 says "cita apenas as bases legais fornecidas" — cites ONLY
 * the supplied ones. This is a hallucination check, not a completeness
 * check: a document that cites a strict subset of `assembled.legalRefs`
 * (including an empty one) still passes, because it has not invented
 * anything. A document citing even one reference outside that set fails
 * the whole criterion (weight 3) — a single invented citation in a document
 * a person sends to a company is the exact failure RF-161 exists to rule
 * out, so there is no partial credit for "mostly not hallucinating".
 */
export function scoreLegalBases(assembled, doc) {
  const allowed = new Set(assembled.legalRefs.map(legalRefKey));
  const extra = doc.legalRefs.filter((ref) => !allowed.has(legalRefKey(ref)));
  const passed = extra.length === 0;
  return {
    criterion: "legalBases",
    weight: RUBRIC_WEIGHTS.legalBases,
    measured: true,
    passed,
    points: passed ? RUBRIC_WEIGHTS.legalBases : 0,
    detail: passed
      ? "nenhuma base legal fora das fornecidas pelos achados"
      : `base(s) legal(is) não fornecida(s), citada(s) mesmo assim: ${extra.map((r) => `${r.law} ${r.article}`).join(" | ")}`,
  };
}

/**
 * RF-162: runs the real `lintUserFacingText` (packages/ai), not a
 * re-derived copy, over exactly the fields RF-162 names — subject, body,
 * each request, each scriptForCall line, each attachment label.
 * `legalRefs` is deliberately not swept, matching
 * `packages/ai/test/invariants/authorship.spec.ts`'s identical choice for
 * INV-003: it is structured law/article data, not prose. Called with no
 * `citations` (strict): a generated contestation is never supposed to quote
 * a norm verbatim, so nothing here is exempt.
 */
export function scoreForbiddenTerms(doc) {
  const fields = [
    ["subject", doc.subject],
    ["body", doc.body],
    ...doc.requests.map((text, i) => [`requests[${i}]`, text]),
    ...doc.scriptForCall.map((text, i) => [`scriptForCall[${i}]`, text]),
    ...doc.attachmentsChecklist.map((text, i) => [`attachmentsChecklist[${i}]`, text]),
  ];
  const violations = [];
  for (const [field, text] of fields) {
    const result = lintUserFacingText(text);
    for (const violation of result.violations) {
      violations.push({ field, term: violation.term, reason: violation.reason });
    }
  }
  const passed = violations.length === 0;
  return {
    criterion: "forbiddenTerms",
    weight: RUBRIC_WEIGHTS.forbiddenTerms,
    measured: true,
    passed,
    points: passed ? RUBRIC_WEIGHTS.forbiddenTerms : 0,
    detail: passed
      ? "zero termos proibidos"
      : `termo(s) proibido(s) encontrado(s): ${violations.map((v) => `${v.field}:"${v.term}"`).join(" | ")}`,
  };
}

/**
 * The full §20.4 rubric for one document. The two criteria this harness
 * cannot measure today (see this file's header) come back as explicit
 * entries with `measured: false, passed: null, points: null` — never
 * silently omitted or defaulted to a pass, which from the outside would be
 * indistinguishable from an actual measured pass.
 */
export function scoreContestDocument(assembled, doc) {
  const measured = [scoreAsks(assembled, doc), scoreLegalBases(assembled, doc), scoreForbiddenTerms(doc)];
  const unmeasured = [
    {
      criterion: "protocolsAndDeadlines",
      weight: RUBRIC_WEIGHTS.protocolsAndDeadlines,
      measured: false,
      passed: null,
      points: null,
      detail:
        "não medido: AssembledContest.protocols não carrega data, então prazo vencido não é computável; menção textual também exige julgamento",
    },
    {
      criterion: "lengthAndTone",
      weight: RUBRIC_WEIGHTS.lengthAndTone,
      measured: false,
      passed: null,
      points: null,
      detail: "não medido: tamanho é trivial, mas o critério também exige tom neutro, que precisa de um modelo",
    },
  ];
  const measuredPoints = measured.reduce((sum, c) => sum + c.points, 0);
  return {
    criteria: [...measured, ...unmeasured],
    measuredPoints,
    measuredMax: MEASURED_MAX,
    rubricMax: RUBRIC_MAX,
    passed: measured.every((c) => c.passed),
  };
}

// =====================================================================
// Sample-directory scanning
// =====================================================================

/** Directories directly under `sampleDir` — a stray README or other file alongside them is ignored, same convention as golden-run.mjs's `listCaseDirs`. */
function listCaseDirs(sampleDir) {
  if (!existsSync(sampleDir)) return [];
  return readdirSync(sampleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sampleDir, entry.name))
    .sort();
}

function readJson(path, caseDir, label) {
  if (!existsSync(path)) {
    throw new Error(`eval-contest case ${caseDir} is missing ${label}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`eval-contest case ${caseDir}: ${label} is not valid JSON (${err.message})`);
  }
}

/**
 * Loads one case: a generated `ContestDocument` (validated against the real
 * A7 schema — a document that fails validation is never scored as if it
 * were a real one) and the `AssembledContest` baseline it was generated
 * against. Throws on any malformed case — never a partial, silently-skipped
 * result, same convention as golden-run.mjs's `runCase`.
 */
function loadCase(caseDir) {
  const document = ContestDocument.parse(readJson(join(caseDir, "document.json"), caseDir, "document.json"));
  const assembled = readJson(join(caseDir, "assembled.json"), caseDir, "assembled.json");
  for (const field of ["asks", "legalRefs"]) {
    if (!Array.isArray(assembled[field])) {
      throw new Error(`eval-contest case ${caseDir}: assembled.json is missing its "${field}" array`);
    }
  }
  return { caseDir, document, assembled };
}

/**
 * Runs the full §20.4 harness against `sampleDir` and returns a structured
 * report — never prints or exits itself, so tests can assert on it directly
 * instead of scraping stdout (same shape as golden-run.mjs's `runGoldenSet`).
 */
export async function runContestEval(sampleDir) {
  const caseDirs = listCaseDirs(sampleDir);
  const lines = [];

  if (caseDirs.length === 0) {
    lines.push(`contest eval sample: 0 (scanned ${sampleDir})`);
    lines.push(
      "WARNING: no generated contestation sample — §20.4's rubric is not being measured " +
        "(no AI_GATEWAY_API_KEY yet means Task 2's generator has never produced a document to score). " +
        "This run passes vacuously.",
    );
    return { sampleDir, caseCount: 0, vacuous: true, passed: true, cases: [], lines };
  }

  const cases = caseDirs.map((caseDir) => {
    const loaded = loadCase(caseDir);
    return { ...loaded, score: scoreContestDocument(loaded.assembled, loaded.document) };
  });

  lines.push(`contest eval sample: ${cases.length}`);
  lines.push(
    `§20.4 medido hoje (sem modelo): pedidos do playbook (peso ${RUBRIC_WEIGHTS.asks}), ` +
      `bases legais (peso ${RUBRIC_WEIGHTS.legalBases}), termos proibidos (peso ${RUBRIC_WEIGHTS.forbiddenTerms}) ` +
      `— ${MEASURED_MAX}/${RUBRIC_MAX} pontos da rubrica.`,
  );
  lines.push(
    `NÃO medido por este harness (precisa de modelo): protocolos/prazos vencidos, tamanho e tom ` +
      `— ${RUBRIC_MAX - MEASURED_MAX}/${RUBRIC_MAX} pontos. A aprovação do bloco (>= 8/10) não pode ser ` +
      "certificada por este harness sozinho.",
  );

  let passed = true;
  for (const { caseDir, score } of cases) {
    const status = score.passed ? "OK" : "FAIL";
    lines.push(`  ${caseDir}: ${score.measuredPoints}/${score.measuredMax} pontos medidos (${status})`);
    if (!score.passed) {
      passed = false;
      for (const criterion of score.criteria.filter((c) => c.measured && !c.passed)) {
        lines.push(`    ${criterion.criterion} (peso ${criterion.weight}): ${criterion.detail}`);
      }
    }
  }

  if (passed) {
    lines.push(`Todos os ${cases.length} caso(s) cravam os ${MEASURED_MAX} pontos medidos deterministicamente.`);
  } else {
    lines.push(
      "FALHOU: pelo menos um caso violou um critério determinístico (pedido do playbook ausente, " +
        "base legal não fornecida ou termo proibido).",
    );
  }

  return { sampleDir, caseCount: cases.length, vacuous: false, passed, cases, lines };
}

// =====================================================================
// CLI
// =====================================================================

async function main(argv) {
  const sampleDir = argv[0] ? resolve(argv[0]) : DEFAULT_SAMPLE_DIR;
  let report;
  try {
    report = await runContestEval(sampleDir);
  } catch (err) {
    console.error(`eval:contest failed: ${err.message}`);
    return 1;
  }
  for (const line of report.lines) {
    (report.passed ? console.log : console.error)(line);
  }
  return report.passed ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
