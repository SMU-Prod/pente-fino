// scripts/eval-contest.test.mjs
//
// Run with `node --test scripts` (wired into the root `pnpm test` — see
// package.json). Uses node:test/node:assert for the same reason
// scripts/golden-run.test.mjs does: this script runs with plain Node, no
// build step, and the test should exercise exactly that same execution
// path.
//
// E4 Task 5: the §20.4 rubric harness. Three of its five criteria — all the
// playbook's asks for the stage, only the supplied legal bases, zero
// forbidden terms — are deterministic and are what this suite proves:
//
//   1. A hand-built "generated-like" document that satisfies every
//      deterministic criterion scores full marks.
//   2. Three separate failure fixtures, one per deterministic criterion —
//      a missing ask, a legal reference nobody supplied, a forbidden term —
//      each drags exactly that criterion's points to zero and is named in
//      the report, the same way golden-run.test.mjs proves RNF-16 actually
//      catches a regression instead of only ever passing.
//   3. An empty sample scans zero cases and says so loudly — never a
//      silent, vacuous pass of the block's own "eval com rubrica >= 8/10"
//      gate (PRD §18) — mirroring golden-run.mjs's own empty-golden-set
//      behaviour exactly.
//
// The other two rubric criteria (protocols/expired deadlines, length and
// neutral tone) need either data this repo's `AssembledContest` does not
// carry yet (no date on a recorded protocol) or a model's judgment of tone,
// and are asserted below to come back explicitly unmeasured, never silently
// scored as passing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { assembleContest } from "../packages/core/src/documents/assemble.ts";

import {
  runContestEval,
  scoreContestDocument,
  scoreAsks,
  scoreLegalBases,
  scoreForbiddenTerms,
  RUBRIC_WEIGHTS,
  MEASURED_MAX,
  RUBRIC_MAX,
  DEFAULT_SAMPLE_DIR,
} from "./eval-contest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "eval-contest.mjs");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "eval-contest-test-"));
}

// §20.2's reference telecom playbook, trimmed to the "sac" stage this suite
// needs — the same fixture shape packages/core/src/documents/assemble.test.ts
// and packages/ai/test/invariants/authorship.spec.ts already use for it.
const TELECOM_PLAYBOOK = {
  stages: [
    {
      stage: "sac",
      channel: "SAC da operadora",
      responseDays: 7,
      businessDays: false,
      requiresPreviousProtocol: false,
      asks: [
        "número de protocolo",
        "suspensão imediata da cobrança contestada",
        "cópia da gravação do atendimento",
      ],
      legalRefs: [{ law: "Decreto 11.034/2022", article: "art. 13 e §3º", effect: "suspensao" }],
    },
  ],
};

const CDC_ART_42 = { law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" };

function findingWith(legalBasis) {
  return {
    ruleSlug: "regra-teste",
    ruleVersion: 1,
    itemId: null,
    amountCents: 1000,
    doubledCents: null,
    confidence: 0.9,
    evidence: ["Encontramos R$ 10,00 para você verificar"],
    legalBasis,
    shadow: false,
  };
}

/** The real assembleContest output for one finding carrying CDC_ART_42, at the "sac" stage. */
function assembledFixture() {
  return assembleContest({ findings: [findingWith([CDC_ART_42])], stage: "sac", playbook: TELECOM_PLAYBOOK });
}

/** A ContestDocument that satisfies every deterministic criterion against `assembledFixture()`. */
function cleanDocument() {
  return {
    subject: "Contestação de cobrança — Linha (11) 98765-4321",
    body:
      "Solicito a suspensão imediata da cobrança contestada referente ao valor de R$ 10,00 " +
      "identificado na fatura. Não reconheço esse lançamento e peço o número de protocolo " +
      "deste atendimento, além da cópia da gravação do atendimento, para acompanhar o caso.",
    requests: ["Suspensão imediata da cobrança contestada.", "Número de protocolo do atendimento."],
    legalRefs: [{ law: "CDC", article: "art. 42, parágrafo único" }],
    scriptForCall: ["Pedir o número de protocolo do atendimento.", "Pedir a gravação da ligação."],
    attachmentsChecklist: ["Fatura do período contestado."],
  };
}

function writeCase(sampleDir, caseName, { document, assembled }) {
  const caseDir = join(sampleDir, caseName);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "document.json"), JSON.stringify(document, null, 2));
  writeFileSync(join(caseDir, "assembled.json"), JSON.stringify(assembled, null, 2));
  return caseDir;
}

// =====================================================================
// The behaviour that matters most: an empty sample measures nothing, and
// says so — never a vacuous pass of §18's "eval com rubrica >= 8/10" gate.
// =====================================================================

describe("empty sample", () => {
  test("reports zero cases and PASSES vacuously when the directory has no case subdirectories", async () => {
    const dir = tempDir();
    try {
      const report = await runContestEval(dir);
      assert.equal(report.caseCount, 0);
      assert.equal(report.vacuous, true);
      assert.equal(report.passed, true);
      assert.ok(report.lines.some((l) => l.includes("WARNING")));
      assert.ok(report.lines.some((l) => l.includes("20.4")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports zero cases and PASSES when the directory does not exist at all", async () => {
    const dir = join(tempDir(), "does-not-exist");
    const report = await runContestEval(dir);
    assert.equal(report.caseCount, 0);
    assert.equal(report.passed, true);
  });

  test("the real default sample directory is still empty and the gate passes over it (no AI_GATEWAY_API_KEY yet)", async () => {
    const report = await runContestEval(DEFAULT_SAMPLE_DIR);
    assert.equal(report.caseCount, 0);
    assert.equal(report.passed, true);
  });

  test("the CLI exits 0 on an empty directory and prints the loud warning", () => {
    const dir = tempDir();
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      assert.match(stdout, /contest eval sample: 0/);
      assert.match(stdout, /WARNING/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// A document that gets everything right: full marks on all three
// deterministic criteria.
// =====================================================================

describe("a correctly generated-like document", () => {
  test("scores full marks on every deterministic criterion", () => {
    const assembled = assembledFixture();
    const doc = cleanDocument();
    const score = scoreContestDocument(assembled, doc);
    assert.equal(score.passed, true);
    assert.equal(score.measuredPoints, MEASURED_MAX);
    assert.equal(score.measuredMax, RUBRIC_WEIGHTS.asks + RUBRIC_WEIGHTS.legalBases + RUBRIC_WEIGHTS.forbiddenTerms);
  });

  test("the two criteria needing a model come back explicitly unmeasured, never silently passing", () => {
    const score = scoreContestDocument(assembledFixture(), cleanDocument());
    const unmeasured = score.criteria.filter((c) => !c.measured);
    assert.equal(unmeasured.length, 2);
    assert.deepEqual(
      unmeasured.map((c) => c.criterion).sort(),
      ["lengthAndTone", "protocolsAndDeadlines"],
    );
    for (const c of unmeasured) {
      assert.equal(c.passed, null);
      assert.equal(c.points, null);
    }
    assert.equal(RUBRIC_MAX - MEASURED_MAX, 2);
  });

  test("runContestEval over a directory holding this one clean case PASSES end to end", async () => {
    const dir = tempDir();
    try {
      writeCase(dir, "clean-1", { document: cleanDocument(), assembled: assembledFixture() });
      const report = await runContestEval(dir);
      assert.equal(report.caseCount, 1);
      assert.equal(report.passed, true);
      assert.equal(report.cases[0].score.measuredPoints, MEASURED_MAX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI exits 0 over the clean case", () => {
    const dir = tempDir();
    try {
      writeCase(dir, "clean-1", { document: cleanDocument(), assembled: assembledFixture() });
      const stdout = execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      assert.match(stdout, /contest eval sample: 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// Proof, one fixture per deterministic criterion: the score actually moves.
// =====================================================================

describe("a document missing one of the playbook's asks", () => {
  test("scoreAsks fails and names the missing ask", () => {
    const assembled = assembledFixture();
    const doc = cleanDocument();
    // Strip every mention of the recording request from every field.
    doc.body = doc.body.replace(/além da cópia da gravação do atendimento, /, "");
    doc.scriptForCall = doc.scriptForCall.filter((line) => !line.includes("gravação"));
    const result = scoreAsks(assembled, doc);
    assert.equal(result.passed, false);
    assert.equal(result.points, 0);
    assert.match(result.detail, /gravação/);
  });

  test("drags the whole document's score down by exactly the asks weight", () => {
    const assembled = assembledFixture();
    const doc = cleanDocument();
    doc.body = doc.body.replace(/além da cópia da gravação do atendimento, /, "");
    doc.scriptForCall = doc.scriptForCall.filter((line) => !line.includes("gravação"));
    const score = scoreContestDocument(assembled, doc);
    assert.equal(score.passed, false);
    assert.equal(score.measuredPoints, MEASURED_MAX - RUBRIC_WEIGHTS.asks);
  });

  test("the CLI exits non-zero and names the case and the missing ask", () => {
    const dir = tempDir();
    try {
      const doc = cleanDocument();
      doc.body = doc.body.replace(/além da cópia da gravação do atendimento, /, "");
      doc.scriptForCall = doc.scriptForCall.filter((line) => !line.includes("gravação"));
      const caseDir = writeCase(dir, "missing-ask", { document: doc, assembled: assembledFixture() });
      let error;
      try {
        execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      } catch (err) {
        error = err;
      }
      assert.ok(error, "expected the CLI to exit non-zero");
      assert.notEqual(error.status, 0);
      assert.match(error.stderr, /asks/);
      assert.match(error.stderr, new RegExp(caseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a document citing a legal basis nobody supplied", () => {
  test("scoreLegalBases fails and names the extra reference", () => {
    const assembled = assembledFixture(); // only carries CDC_ART_42
    const doc = cleanDocument();
    doc.legalRefs = [...doc.legalRefs, { law: "Lei 8.078/1990", article: "art. 6º, VI" }];
    const result = scoreLegalBases(assembled, doc);
    assert.equal(result.passed, false);
    assert.equal(result.points, 0);
    assert.match(result.detail, /8\.078/);
  });

  test("a document that omits the supplied basis entirely still passes — the criterion is about not inventing one", () => {
    // §20.4's wording is "cita apenas as bases legais fornecidas" (cites
    // ONLY the supplied ones) — an empty legalRefs array cites nothing
    // outside the supplied set, so it is not a hallucination.
    const assembled = assembledFixture();
    const doc = cleanDocument();
    doc.legalRefs = [];
    const result = scoreLegalBases(assembled, doc);
    assert.equal(result.passed, true);
  });

  test("drags the whole document's score down by exactly the legal-bases weight", () => {
    const assembled = assembledFixture();
    const doc = cleanDocument();
    doc.legalRefs = [...doc.legalRefs, { law: "Lei 8.078/1990", article: "art. 6º, VI" }];
    const score = scoreContestDocument(assembled, doc);
    assert.equal(score.passed, false);
    assert.equal(score.measuredPoints, MEASURED_MAX - RUBRIC_WEIGHTS.legalBases);
  });

  test("the CLI exits non-zero and names the case and the unsupplied reference", () => {
    const dir = tempDir();
    try {
      const doc = cleanDocument();
      doc.legalRefs = [...doc.legalRefs, { law: "Lei 8.078/1990", article: "art. 6º, VI" }];
      const caseDir = writeCase(dir, "extra-legal-ref", { document: doc, assembled: assembledFixture() });
      let error;
      try {
        execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      } catch (err) {
        error = err;
      }
      assert.ok(error, "expected the CLI to exit non-zero");
      assert.notEqual(error.status, 0);
      assert.match(error.stderr, /legalBases/);
      assert.match(error.stderr, new RegExp(caseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a document containing a forbidden term", () => {
  test("scoreForbiddenTerms fails and names the field and the term", () => {
    const doc = cleanDocument();
    doc.body += " Nosso advogado vai garantir o resultado.";
    const result = scoreForbiddenTerms(doc);
    assert.equal(result.passed, false);
    assert.equal(result.points, 0);
    assert.match(result.detail, /body/);
    assert.match(result.detail, /advogado/);
  });

  test("this is the actual §14.3 lint, not a re-derived copy — a plural and an accent-free spelling are caught too", () => {
    const doc = cleanDocument();
    doc.requests = [...doc.requests, "Consultoria juridica sobre o caso."];
    const result = scoreForbiddenTerms(doc);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("requests"));
  });

  test("drags the whole document's score down by exactly the forbidden-terms weight", () => {
    const assembled = assembledFixture();
    const doc = cleanDocument();
    doc.body += " Nosso advogado vai garantir o resultado.";
    const score = scoreContestDocument(assembled, doc);
    assert.equal(score.passed, false);
    assert.equal(score.measuredPoints, MEASURED_MAX - RUBRIC_WEIGHTS.forbiddenTerms);
  });

  test("the CLI exits non-zero and names the case, the field and the term", () => {
    const dir = tempDir();
    try {
      const doc = cleanDocument();
      doc.body += " Nosso advogado vai garantir o resultado.";
      const caseDir = writeCase(dir, "forbidden-term", { document: doc, assembled: assembledFixture() });
      let error;
      try {
        execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: "utf8" });
      } catch (err) {
        error = err;
      }
      assert.ok(error, "expected the CLI to exit non-zero");
      assert.notEqual(error.status, 0);
      assert.match(error.stderr, /forbiddenTerms/);
      assert.match(error.stderr, /advogado/);
      assert.match(error.stderr, new RegExp(caseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// Malformed cases fail loudly instead of being silently skipped, and a
// document failing schema validation is never scored as if it were valid.
// =====================================================================

describe("malformed cases", () => {
  test("a case directory missing document.json throws, naming the case", async () => {
    const dir = tempDir();
    try {
      const caseDir = join(dir, "broken");
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "assembled.json"), JSON.stringify(assembledFixture()));
      await assert.rejects(() => runContestEval(dir), /document\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a case directory missing assembled.json throws, naming the case", async () => {
    const dir = tempDir();
    try {
      const caseDir = join(dir, "broken");
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "document.json"), JSON.stringify(cleanDocument()));
      await assert.rejects(() => runContestEval(dir), /assembled\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a document.json that fails the ContestDocument schema throws instead of being scored", async () => {
    const dir = tempDir();
    try {
      const badDoc = { ...cleanDocument(), body: "corto demais" }; // under 200 chars
      writeCase(dir, "broken", { document: badDoc, assembled: assembledFixture() });
      await assert.rejects(() => runContestEval(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
