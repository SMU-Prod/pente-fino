// scripts/golden-anonymize.test.mjs
//
// Run with `node --test scripts` (wired into the root `pnpm test` — see
// package.json). Uses node:test/node:assert rather than vitest because
// this script runs with plain Node, no build step, and the test should
// exercise exactly that same execution path.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { anonymizePdf, UnsupportedPdfError } from "./golden-anonymize.mjs";
import { createUnpdfReader } from "../packages/adapters/src/reader/unpdf.ts";
import { containsPii } from "../packages/core/src/invoice/mask.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "fixtures", "synthetic", "pdfs");
const SCRIPT_PATH = join(HERE, "golden-anonymize.mjs");

function fixtureBytes(name) {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "golden-anonymize-test-"));
}

// ---------------------------------------------------------------------
// A second, minimal hand-built PDF constructor — deliberately separate
// from fixtures/synthetic/pdfs/make-fixtures.mjs, whose fixtures are
// fixed content this suite reads rather than a library it calls. This
// mirrors the same technique (byte-exact xref offsets computed from the
// bytes actually written) but lets a test supply an ARBITRARY raw
// content stream, which is what the "rejects unsupported content" tests
// below need (a TJ array, a hex string — shapes none of the three
// checked-in fixtures contain).
// ---------------------------------------------------------------------

function assembleMinimalPdf(contentStreamText) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.from(contentStreamText, "latin1").length} >>\nstream\n${contentStreamText}\nendstream`,
  ];

  const header = "%PDF-1.4\n";
  const chunks = [header];
  const offsets = [];
  let offset = header.length;
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(xref, trailer);
  return new Uint8Array(Buffer.from(chunks.join(""), "latin1"));
}

// =====================================================================
// Pass-through: no PII anywhere -> byte-identical output.
// =====================================================================

describe("no PII at all passes through unchanged", () => {
  for (const name of ["text-2page.pdf", "scan-1page.pdf", "text-13page.pdf"]) {
    test(`${name} is byte-identical after anonymisation`, async () => {
      const input = fixtureBytes(name);
      const { bytes, report } = await anonymizePdf(input);
      assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(input)), 0);
      assert.equal(report.pagesWithChanges, 0);
    });
  }

  test("text-2page.pdf's issuer CNPJ alone does not count as PII to remove", async () => {
    // text-2page.pdf carries only "CNPJ 40.432.544/0001-47" — no CPF,
    // name, address or phone — so this is really the same assertion as
    // above from the other direction: the script must not treat the
    // issuer's CNPJ as something to redact.
    const input = fixtureBytes("text-2page.pdf");
    const { report } = await anonymizePdf(input);
    assert.equal(report.core, 0);
    assert.equal(report.name, 0);
    assert.equal(report.phone, 0);
  });
});

// =====================================================================
// The PII-bearing fixture: CPF, name, address, phone masked; CNPJ kept.
// =====================================================================

describe("text-pii-sample.pdf", () => {
  test("every CPF pattern is gone from the extracted text", async () => {
    const input = fixtureBytes("text-pii-sample.pdf");
    const { bytes } = await anonymizePdf(input);
    const after = await createUnpdfReader().read(new Uint8Array(bytes));
    const joined = after.pages.join("\n");
    assert.ok(!joined.includes("111.444.777-35"), "the raw CPF must not survive");
    assert.ok(!/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(joined), "no CPF-shaped run must survive");
  });

  test("the page count is unchanged", async () => {
    // Two independent fixtureBytes() calls, not one shared buffer: unpdf's
    // underlying pdf.js consumes (detaches) the Uint8Array it is given,
    // so reading it once and then handing the same buffer to
    // anonymizePdf would starve the second use.
    const before = await createUnpdfReader().read(fixtureBytes("text-pii-sample.pdf"));
    const { bytes } = await anonymizePdf(fixtureBytes("text-pii-sample.pdf"));
    const after = await createUnpdfReader().read(new Uint8Array(bytes));
    assert.equal(after.pageCount, before.pageCount);
  });

  test("the issuer CNPJ survives untouched (it is not customer PII)", async () => {
    const input = fixtureBytes("text-pii-sample.pdf");
    const { bytes } = await anonymizePdf(input);
    const after = await createUnpdfReader().read(new Uint8Array(bytes));
    assert.ok(after.pages.join("\n").includes("40.432.544/0001-47"));
  });

  test("name, address and phone are masked; nothing else is touched — the exact expected text", async () => {
    // See the comment in the previous test: a fresh buffer per consumer,
    // because unpdf detaches the Uint8Array it reads.
    const before = await createUnpdfReader().read(fixtureBytes("text-pii-sample.pdf"));
    const { bytes } = await anonymizePdf(fixtureBytes("text-pii-sample.pdf"));
    const after = await createUnpdfReader().read(new Uint8Array(bytes));

    // This is the precise "layout preserved" assertion: build the
    // expected page 1 by substituting ONLY the known PII spans into the
    // ORIGINAL text, in place, and require the result to match exactly —
    // proving every other character (including the "Nome:"/"CPF:" labels,
    // the CNPJ, the total and the due date) sits exactly where it did
    // before, and only the replaced spans changed length.
    const expectedPage1 = before.pages[0]
      .replace("Fulano de Tal", "[NOME]")
      .replace("111.444.777-35", "[CPF]")
      .replace("Rua das Palmeiras, 123 - Bairro Centro", "[ENDERECO]")
      .replace("(11) 98765-4321", "[TELEFONE]");

    assert.equal(after.pages[0], expectedPage1);
    assert.equal(after.pages[1], before.pages[1]); // page 2 carried no PII at all
  });

  test("no PII the core detector recognises remains, once the preserved CNPJ is excluded", async () => {
    const input = fixtureBytes("text-pii-sample.pdf");
    const { bytes } = await anonymizePdf(input);
    const after = await createUnpdfReader().read(new Uint8Array(bytes));
    const strippedOfCnpj = after.pages.join("\n").replace("40.432.544/0001-47", "");
    assert.equal(containsPii(strippedOfCnpj), false);
  });

  test("is deterministic: re-running on the same input produces a byte-identical file", async () => {
    const input = fixtureBytes("text-pii-sample.pdf");
    const first = await anonymizePdf(input);
    const second = await anonymizePdf(input);
    assert.equal(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)), 0);
  });

  test("running the script again on its own output does not churn (idempotent — a committed fixture stays stable)", async () => {
    const input = fixtureBytes("text-pii-sample.pdf");
    const once = await anonymizePdf(input);
    const twice = await anonymizePdf(new Uint8Array(once.bytes));
    assert.equal(Buffer.compare(Buffer.from(once.bytes), Buffer.from(twice.bytes)), 0);
  });
});

// =====================================================================
// Unsupported shapes: fail loudly, write nothing.
// =====================================================================

async function readPdfText(bytes) {
  const result = await createUnpdfReader().read(new Uint8Array(bytes));
  return result.pages.join("\n");
}

describe("kerned and hex text: the shapes a real invoice generator emits", () => {
  // The reason this matters: a generator that kerns glyphs splits one
  // visible line across several string fragments, so a CPF can be stored
  // as `(CPF: 111)` `-2` `(.444.777-35)` and matches no detector looking
  // for a whole CPF. A script that read fragments one at a time would
  // write out a file it believed was redacted and that still carried the
  // number. 111.444.777-35 is check-digit valid, which is what makes
  // `containsPii` willing to see it at all.
  test("masks a CPF split across the fragments of a TJ array", async () => {
    const pdf = assembleMinimalPdf("BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n[(CPF: 111)-2(.444.777-35)] TJ\nET");
    const { bytes } = await anonymizePdf(pdf);
    const text = await readPdfText(bytes);
    assert.match(text, /\[CPF\]/);
    assert.equal(containsPii(text), false);
    assert.doesNotMatch(text, /111\.444\.777-35/);
  });

  test("masks a CPF in a hex string", async () => {
    // "CPF: 111.444.777-35" in latin-1 hex.
    const hex = Buffer.from("CPF: 111.444.777-35", "latin1").toString("hex").toUpperCase();
    const pdf = assembleMinimalPdf(`BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n<${hex}> Tj\nET`);
    const { bytes } = await anonymizePdf(pdf);
    const text = await readPdfText(bytes);
    assert.match(text, /\[CPF\]/);
    assert.doesNotMatch(text, /111\.444\.777-35/);
  });

  // A redacted TJ array has to be written back as an ARRAY - `[(x)] TJ`,
  // never a bare `(x) TJ`, which is a string operand handed to an operator
  // that takes an array. Reading the output back with unpdf does not catch
  // that (unpdf is forgiving), so the check is that the script can re-parse
  // its own output: this scanner rejects a literal in front of TJ, so a
  // malformed rewrite fails here loudly instead of shipping a corrupt
  // fixture into the golden set.
  test("re-parses its own output for a redacted TJ array, so the rewrite stays well-formed", async () => {
    const pdf = assembleMinimalPdf("BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n[(CPF: 111)-2(.444.777-35)] TJ\nET");
    const once = await anonymizePdf(pdf);
    const twice = await anonymizePdf(new Uint8Array(once.bytes));
    assert.equal(Buffer.compare(Buffer.from(once.bytes), Buffer.from(twice.bytes)), 0);
  });

  test("leaves a TJ array that needs no masking byte-identical, kerning included", async () => {
    const content = "BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n[(Total a )-250(pagar: R$ 159,90)] TJ\nET";
    const pdf = assembleMinimalPdf(content);
    const { bytes } = await anonymizePdf(pdf);
    // The kerning adjustment survives untouched, because nothing on this
    // line changed. Only a line that IS redacted loses its kerning.
    assert.ok(Buffer.from(bytes).toString("latin1").includes("[(Total a )-250(pagar: R$ 159,90)] TJ"));
  });

  test("reads the next-line shorthand operators as text too", async () => {
    const pdf = assembleMinimalPdf("BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n(CPF: 111.444.777-35) '\nET");
    const { bytes } = await anonymizePdf(pdf);
    const text = await readPdfText(bytes);
    assert.match(text, /\[CPF\]/);
    assert.doesNotMatch(text, /111\.444\.777-35/);
  });

  test("a non-text array operand (a dash pattern) is left alone rather than mistaken for text", async () => {
    const content = "0.5 w [3 3] 0 d\n72 700 m 540 700 l S\nBT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n(Fatura) Tj\nET";
    const pdf = assembleMinimalPdf(content);
    const { bytes } = await anonymizePdf(pdf);
    assert.ok(Buffer.from(bytes).toString("latin1").includes("[3 3] 0 d"));
  });
});

// =====================================================================
// Unsupported shapes: fail loudly, write nothing.
// =====================================================================

describe("refuses PDF shapes it cannot safely edit", () => {
  test("a string operand followed by an operator that does not show text is rejected", async () => {
    // `Tz` sets horizontal scaling and takes a number, never a string.
    // Meeting one here means the stream is not the shape this script
    // believes it is parsing, so it stops instead of guessing.
    const pdf = assembleMinimalPdf("BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n(CPF: 111.444.777-35) Tz\nET");
    await assert.rejects(() => anonymizePdf(pdf), UnsupportedPdfError);
  });

  test("an array of strings followed by something other than TJ is rejected", async () => {
    const pdf = assembleMinimalPdf("BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n[(CPF: 111)(.444.777-35)] Tw\nET");
    await assert.rejects(() => anonymizePdf(pdf), UnsupportedPdfError);
  });

  test("the CLI exits non-zero and writes nothing for an unsupported PDF", () => {
    const dir = tempDir();
    try {
      const pdf = assembleMinimalPdf("BT\n/F1 14 Tf\n1 0 0 1 72 720 Tm\n(x) Tz\nET");
      const inputPath = join(dir, "unsupported.pdf");
      writeFileSync(inputPath, pdf);
      assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH, inputPath, join(dir, "out")]));
      assert.equal(existsSync(join(dir, "out", "source.pdf")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// CLI interface: `pnpm golden:anonymize <input.pdf> <output-dir>`.
// =====================================================================

describe("CLI: pnpm golden:anonymize <input.pdf> <output-dir>", () => {
  test("writes <output-dir>/source.pdf and warns about the heuristic fields", () => {
    const dir = tempDir();
    try {
      const inputPath = join(FIXTURES_DIR, "text-pii-sample.pdf");
      const stdout = execFileSync(process.execPath, [SCRIPT_PATH, inputPath, dir], { encoding: "utf8" });
      const outputPath = join(dir, "source.pdf");
      assert.ok(readFileSync(outputPath).length > 0);
      assert.match(stdout, /WARNING/);
      assert.match(stdout, /source\.pdf/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the output directory when it does not exist yet", () => {
    const dir = join(tempDir(), "nested", "case-dir");
    try {
      const inputPath = join(FIXTURES_DIR, "text-2page.pdf");
      execFileSync(process.execPath, [SCRIPT_PATH, inputPath, dir]);
      assert.ok(readFileSync(join(dir, "source.pdf")).length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prints usage and exits non-zero when arguments are missing", () => {
    assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" }));
  });

  test("fails cleanly (no stack trace crash) when the input file does not exist", () => {
    const dir = tempDir();
    try {
      assert.throws(() =>
        execFileSync(process.execPath, [SCRIPT_PATH, join(dir, "does-not-exist.pdf"), join(dir, "out")], {
          encoding: "utf8",
        }),
      );
      assert.equal(existsSync(join(dir, "out")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
