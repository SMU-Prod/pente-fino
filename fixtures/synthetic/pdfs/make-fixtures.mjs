#!/usr/bin/env node
// fixtures/synthetic/pdfs/make-fixtures.mjs
//
// Emits hand-built, minimal-but-valid PDF files for testing the unpdf
// DocumentReader adapter (packages/adapters/src/reader/unpdf.ts). No
// dependency beyond Node itself: a PDF is just bytes, and writing them
// directly (instead of going through a PDF-writing library) means these
// fixtures can't quietly inherit fixes for the exact bugs the reader needs
// to survive - a missing text layer, a bad xref offset, a page with no
// content at all.
//
// A minimal PDF is, in order:
//   header -> a run of numbered indirect objects (catalog, page tree,
//   page(s), a font, a content stream per page) -> a cross-reference
//   (xref) table giving the exact byte offset of every object -> a
//   trailer naming the catalog -> a startxref pointer to the xref
//   table's own offset -> %%EOF.
//
// The xref offsets are the part everyone gets wrong by hand: they are
// counted from byte 0 of the whole file, and touching any object shifts
// every offset that comes after it. Nothing here is hardcoded - offsets
// are always computed from the bytes already written (see assemblePdf
// below), so restructuring a fixture (one more page, one more line of
// text) can never leave a stale offset behind.
//
// Run: `node fixtures/synthetic/pdfs/make-fixtures.mjs` to regenerate.
// The output is committed alongside this script so CI never has to run
// it, and a diff in the .pdf files always has this script's diff next to
// it to explain why.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ---- low-level PDF object assembly ----------------------------------

// PDF strings are written as byte sequences, not Unicode text. Every piece
// we build here (header, object bodies, xref, trailer) goes through the
// "latin1" encoding, which maps each JS string code unit 0-255 directly to
// one byte. That covers plain ASCII plus the couple of accented
// characters ("Claro Móvel") in the fixture below - "ó" is U+00F3, which
// is byte 0xF3 in both Latin-1 and WinAnsiEncoding (the font Encoding we
// declare), so the byte we write is exactly the byte a WinAnsi-encoding
// PDF reader expects for that glyph. Using "utf8" anywhere here would
// silently re-encode that character to two bytes and desync every offset
// after it.
const ENCODING = "latin1";

function toBytes(text) {
  return Buffer.from(text, ENCODING);
}

/**
 * Escapes a string for use inside a PDF literal string, i.e. `(...)`.
 * Only `(`, `)` and `\` are special inside a literal string - unescaped,
 * any of them would desync PDF's own paren-balancing string scanner, not
 * just our byte-offset bookkeeping.
 */
function escapePdfString(text) {
  return text.replace(/([()\\])/g, "\\$1");
}

/**
 * Builds a `<< /Length N >> stream ... endstream` object body. `Length`
 * must equal the exact byte length of the bytes between `stream\n` and
 * `\nendstream` - computed here, never guessed, for the same reason the
 * xref offsets are computed rather than hardcoded.
 */
function streamObject(streamText, extraDictEntries = "") {
  const length = toBytes(streamText).length;
  return `<< /Length ${length}${extraDictEntries} >>\nstream\n${streamText}\nendstream`;
}

/**
 * Assembles a complete PDF file from an ordered list of object bodies.
 * `objectBodies[0]` becomes object 1 (PDF numbers indirect objects from 1;
 * object 0 is reserved for the free-list head the xref table always
 * starts with), `objectBodies[1]` becomes object 2, and so on - so the
 * caller's array index IS the object number minus one. Returns the
 * finished file as a Buffer.
 */
function assemblePdf(objectBodies, rootObjNum) {
  const header = toBytes("%PDF-1.4\n");
  const chunks = [header];
  const offsetOf = new Map(); // object number -> byte offset of "N 0 obj"
  let offset = header.length;

  objectBodies.forEach((body, i) => {
    const objNum = i + 1;
    offsetOf.set(objNum, offset);
    const buf = toBytes(`${objNum} 0 obj\n${body}\nendobj\n`);
    chunks.push(buf);
    offset += buf.length;
  });

  const xrefOffset = offset;
  const entryCount = objectBodies.length + 1; // +1 for the free-list head

  // Every entry in an xref subsection must be exactly 20 bytes (10-digit
  // offset, space, 5-digit generation, space, 'n'/'f', space, newline) -
  // that fixed width is how a reader can seek directly to entry N without
  // scanning the table. Get this wrong and even a correct offset value
  // fails to parse.
  let xref = `xref\n0 ${entryCount}\n0000000000 65535 f \n`;
  for (let objNum = 1; objNum <= objectBodies.length; objNum++) {
    xref += `${String(offsetOf.get(objNum)).padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${entryCount} /Root ${rootObjNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  chunks.push(toBytes(xref), toBytes(trailer));
  return Buffer.concat(chunks);
}

// ---- content-stream builders ------------------------------------------

/**
 * A block of left-aligned text lines, one `Tj` per line, positioned with
 * an absolute text matrix (`Tm`) rather than relative leading (`T*`) so
 * each line's position doesn't depend on getting every prior line right.
 */
function textLinesStream(lines, opts = {}) {
  const fontSize = opts.fontSize ?? 14;
  const startY = opts.startY ?? 720;
  const lineHeight = opts.lineHeight ?? 20;
  const x = opts.x ?? 72;
  const body = lines
    .map((line, i) => `1 0 0 1 ${x} ${startY - i * lineHeight} Tm (${escapePdfString(line)}) Tj`)
    .join("\n");
  return `BT\n/F1 ${fontSize} Tf\n${body}\nET`;
}

// ---- fixture builders ---------------------------------------------------

const FONT_OBJ = 3; // shared by every page in a text PDF

/**
 * A PDF whose pages carry a real text layer: catalog (1), page tree (2),
 * one shared Helvetica font (3), then a (page, content-stream) object
 * pair per page starting at object 4.
 */
function buildTextPdf(pagesLines) {
  const n = pagesLines.length;
  const firstPageObj = FONT_OBJ + 1;
  const kids = Array.from({ length: n }, (_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");

  const objects = [];
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  pagesLines.forEach((lines, i) => {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${FONT_OBJ} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj - 1] = streamObject(textLinesStream(lines));
  });

  return assemblePdf(objects, 1);
}

/**
 * A one-page PDF with a drawn rectangle and no text operators at all - a
 * stand-in for a scanned page, which has geometry (or an /Image XObject
 * in a real scan) but nothing a text extractor can find. `hasTextLayer`
 * must come back false for this file.
 */
function buildScanPdf() {
  const contentObj = 4;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${contentObj} 0 R >>`,
    streamObject("q\n1 0 0 RG\n3 w\n100 100 400 500 re\nS\nQ"),
  ];
  return assemblePdf(objects, 1);
}

// ---- the three fixtures --------------------------------------------

const textTwoPage = buildTextPdf([
  [
    "Claro Móvel",
    "CNPJ 40.432.544/0001-47",
    "Total a pagar R$ 129,90",
    "Vencimento 10/08/2026",
  ],
  ["Página 2 de 2", "Detalhamento de consumo"],
]);

const scanOnePage = buildScanPdf();

const textThirteenPage = buildTextPdf(
  Array.from({ length: 13 }, (_, i) => [
    `Página ${i + 1} de 13`,
    "Fatura sintética para exercitar o limite de páginas do RF-104.",
  ]),
);

const fixtures = {
  "text-2page.pdf": textTwoPage,
  "scan-1page.pdf": scanOnePage,
  "text-13page.pdf": textThirteenPage,
};

for (const [name, bytes] of Object.entries(fixtures)) {
  writeFileSync(join(OUT_DIR, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
