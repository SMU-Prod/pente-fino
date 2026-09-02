#!/usr/bin/env node
// scripts/golden-anonymize.mjs
//
// Anonymises a real invoice PDF for the golden set (PRD §16.2): replaces
// CPF, customer name, address and phone/line number, WHILE PRESERVING THE
// LAYOUT — the layout is precisely what the golden set measures, so a
// script that reflows the document destroys the thing under test.
//
// Usage:
//   pnpm golden:anonymize <input.pdf> <output-dir>
//
// Writes `<output-dir>/source.pdf`. `expected.json` and `findings.json`
// (see fixtures/golden/README.md) are authored by hand afterwards, against
// the anonymised PDF this script produces — this script's only job is the
// PDF.
//
// ---------------------------------------------------------------------
// WHAT THIS SCRIPT ACTUALLY HANDLES (read this before trusting an invoice)
// ---------------------------------------------------------------------
//
// This is not a general-purpose PDF editor. Editing text inside a PDF
// without reflowing it is genuinely hard: a replacement of a different
// length shifts glyph positions, and many PDFs store text in ways a naive
// rewrite corrupts. This script handles exactly one shape of PDF — the
// shape `fixtures/synthetic/pdfs/make-fixtures.mjs` produces, which is
// also how many simple invoice generators (and every fixture this repo
// has today) write PDFs — and REFUSES to touch anything else:
//
//  1. Classical, single cross-reference TABLE (not a PDF 1.5+ compressed
//     cross-reference STREAM, and not an incrementally-updated file with
//     a `/Prev` chain or multiple xref sections). One `trailer`, one
//     `xref` block.
//  2. Every indirect object is generation 0 and "in use" — no free-listed
//     objects, no object streams (`/Type /ObjStream`).
//  3. No `/Encrypt` in the trailer.
//  4. Every stream's `/Length` is a direct integer, never an indirect
//     reference.
//  5. A page's content stream is either uncompressed or `FlateDecode`
//     only — no `LZWDecode`, `ASCII85Decode`, `DCTDecode`, etc.
//  6. Text is shown by one of four operations: `(lit) Tj`, `<hex> Tj`,
//     the `'`/`"` next-line shorthands, or a `TJ` array of string
//     fragments with kerning adjustments between them. The TJ array is
//     the normal case for a real invoice — a generator that kerns glyphs
//     splits one visible line across several fragments — and it is
//     handled by reading the fragments as ONE logical line, because a CPF
//     stored as `(CPF: 111)` `-2` `(.444.777-35)` matches no detector
//     looking for a whole CPF. Anything else that shows text (an inline
//     image operator, an unknown operator taking a string) makes the
//     script refuse the whole file rather than silently masking only the
//     parts it understands and leaving the rest.
//
//     A line whose text is NOT changed is emitted byte-for-byte. A line
//     that IS redacted is rewritten as a single string, so intra-line
//     kerning is lost on that line only — the line whose text is being
//     replaced by a marker anyway. See the scanner's own header for the
//     reasoning.
//  7. Every font a processed page's `/Resources` names is a simple font
//     (`/Type1`, `/TrueType`, …), not a composite `/Type0` (CID) font,
//     and carries no `/Differences` re-encoding. A `Tj` string's bytes
//     are trusted to already BE the Latin-1/WinAnsi text they show —
//     true for the fixtures and for simple, non-subsetting generators,
//     false for most PDFs produced by a browser print-to-PDF or a
//     font-subsetting typesetter, which commonly re-map glyph IDs to
//     values that are not readable text at all.
//
// When a PDF falls outside this shape, the script throws before writing
// anything — never a partial, quietly-incomplete redaction. The error
// names the specific unsupported feature.
//
// Within the supported shape, three further limits are worth knowing
// before trusting the result on a *real* invoice:
//
//  - CPF, address and CEP are detected by reusing
//    `@pentefino/core`'s `maskText`/`containsPii` (the same
//    check-digit-validated detector the runtime pipeline uses) — see
//    `packages/core/src/invoice/mask.ts`. This script does not
//    reimplement that detection.
//  - CNPJ is deliberately NEVER masked, even though it is document-shaped
//    PII by the same core detector. §16.2's list is CPF, name, address
//    and line numbers — CNPJ is the issuer's business registration, not
//    the customer's, and `detectIssuer` (packages/core/src/invoice/
//    detect-issuer.ts) resolves the issuer from exactly this number.
//    Masking it would make every golden case permanently unable to test
//    RF-105. See `protectCnpjSpans` below for how that CNPJ is found
//    without a second, disagreeing detector.
//  - Name and phone/line-number detection have NO equivalent in
//    `packages/core` (E0 deliberately left them unmasked at runtime — see
//    the comment atop `mask.ts`), so this script carries its own,
//    unvalidated heuristics for them:
//      - a NAME is only caught when it follows a recognised label on the
//        same line ("Nome:", "Cliente:", "Titular:", "Razão Social:").
//        An unlabelled name — printed on its own line, which is common —
//        is NOT caught.
//      - a LINE NUMBER is only caught when it looks like a Brazilian
//        phone number (`(11) 98765-4321`, `11987654321`, …). It is a
//        shape heuristic with no check digit to validate it, so it can
//        both over-match (an unrelated 8-9 digit run) and under-match
//        (a line number written in some other shape).
//    **Whoever brings the first real operator invoice through this
//    script must manually inspect `source.pdf` before trusting it** —
//    the script prints a warning to this effect on every run, but it
//    cannot verify these two fields the way it verifies CPF removal.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

// Type-only imports elsewhere in these two files are erased by Node's
// TypeScript syntax stripping before module resolution ever sees them, so
// a plain `node` process (no build step, no tsx) can load these two
// specific files directly. See the E1 task notes for why this is safe
// here and would NOT be safe for `packages/core/src/index.ts` (whose
// exports pull in files with *runtime*, not just type-only, relative
// imports).
import { maskText, containsPii, CNPJ_SHAPE_SOURCE } from "../packages/core/src/invoice/mask.ts";
import { createUnpdfReader } from "../packages/adapters/src/reader/unpdf.ts";

export class UnsupportedPdfError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedPdfError";
  }
}

// =====================================================================
// PDF parsing (classical xref table only — see header comment)
// =====================================================================

const LATIN1 = "latin1";

/**
 * Reads bytes as a Latin-1 string. Latin-1 <-> byte is a lossless 1:1
 * mapping (unlike UTF-8), so every byte value in a PDF — including binary
 * font/image data we never touch — round-trips exactly through this
 * string form and back, the same technique `make-fixtures.mjs` uses.
 */
function bytesToLatin1(bytes) {
  return Buffer.from(bytes).toString(LATIN1);
}

function latin1ToBytes(text) {
  return Buffer.from(text, LATIN1);
}

/** Parses the classical xref table + trailer at the end of the file. */
function parseXrefAndTrailer(text) {
  const startxrefIdx = text.lastIndexOf("startxref");
  if (startxrefIdx === -1) {
    throw new UnsupportedPdfError("no startxref found — not a classical PDF this script understands");
  }
  const startxrefMatch = /startxref\s+(\d+)/.exec(text.slice(startxrefIdx));
  if (!startxrefMatch) {
    throw new UnsupportedPdfError("malformed startxref");
  }
  const xrefOffset = Number(startxrefMatch[1]);
  const atXref = text.slice(xrefOffset);
  if (!/^xref\r?\n/.test(atXref)) {
    // Most likely a PDF 1.5+ cross-reference STREAM (an indirect object
    // with /Type /XRef instead of the literal "xref" keyword), or a
    // hybrid-reference file. Both are outside what this script parses.
    throw new UnsupportedPdfError(
      "unsupported PDF structure: no classical 'xref' table at the startxref offset " +
        "(likely a cross-reference stream / PDF 1.5+ hybrid file, or an encrypted or damaged PDF)",
    );
  }

  const trailerIdx = text.indexOf("trailer", xrefOffset);
  if (trailerIdx === -1) {
    throw new UnsupportedPdfError("no 'trailer' keyword found after the xref table");
  }
  const xrefBody = text.slice(xrefOffset + "xref".length, trailerIdx);
  const lines = xrefBody.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  const subsectionHeader = /^(\d+)\s+(\d+)$/.exec(lines[0] ?? "");
  if (!subsectionHeader) {
    throw new UnsupportedPdfError("unsupported xref: could not parse the subsection header");
  }
  const startNum = Number(subsectionHeader[1]);
  const count = Number(subsectionHeader[2]);
  if (startNum !== 0) {
    throw new UnsupportedPdfError("unsupported xref: subsection does not start at object 0");
  }
  const entryLines = lines.slice(1);
  if (entryLines.length !== count) {
    // A second subsection header would land here as an extra "N M" line
    // that doesn't match the 20-byte entry shape below — multiple
    // subsections are unsupported.
    throw new UnsupportedPdfError("unsupported xref: multiple subsections are not supported");
  }

  const entries = [];
  for (const line of entryLines) {
    const m = /^(\d{10})\s+(\d{5})\s+([nf])\b/.exec(line);
    if (!m) {
      throw new UnsupportedPdfError(`unsupported xref: unparsable entry "${line}"`);
    }
    entries.push({ offset: Number(m[1]), gen: Number(m[2]), inUse: m[3] === "n" });
  }

  // Trailer dict.
  const dictStart = text.indexOf("<<", trailerIdx);
  const dictEnd = findMatchingDictEnd(text, dictStart);
  const trailerDict = text.slice(dictStart, dictEnd);

  if (/\/Encrypt\b/.test(trailerDict)) {
    throw new UnsupportedPdfError("unsupported: encrypted PDF (/Encrypt present in trailer)");
  }
  if (/\/Prev\b/.test(trailerDict)) {
    throw new UnsupportedPdfError("unsupported: incrementally-updated PDF (/Prev present in trailer)");
  }
  const sizeMatch = /\/Size\s+(\d+)/.exec(trailerDict);
  const rootMatch = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailerDict);
  if (!sizeMatch || !rootMatch) {
    throw new UnsupportedPdfError("trailer is missing /Size or /Root");
  }
  const size = Number(sizeMatch[1]);
  if (size !== entries.length) {
    throw new UnsupportedPdfError("trailer /Size does not match the number of xref entries");
  }

  const infoMatch = /\/Info\s+\d+\s+\d+\s+R/.exec(trailerDict);
  const idMatch = /\/ID\s*\[[^\]]*\]/.exec(trailerDict);
  const extraTrailerEntries = [infoMatch?.[0], idMatch?.[0]].filter(Boolean).join(" ");

  return {
    size,
    rootNum: Number(rootMatch[1]),
    entries, // entries[0] is the free-list head; entries[i] describes object i
    extraTrailerEntries,
  };
}

/** Finds the offset just past the `>>` matching the `<<` at `start`. */
function findMatchingDictEnd(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith("<<", i)) {
      depth++;
      i += 2;
    } else if (text.startsWith(">>", i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  throw new UnsupportedPdfError("unterminated dictionary (unbalanced << >>)");
}

/**
 * Parses one indirect object at a known byte offset into its dict text
 * and (if present) its raw stream bytes, using the object's own /Length.
 */
function parseObjectAt(text, num, offset) {
  const header = new RegExp(`^${num}\\s+(\\d+)\\s+obj\\b`);
  const headerMatch = header.exec(text.slice(offset));
  if (!headerMatch) {
    throw new UnsupportedPdfError(`xref offset for object ${num} does not point at "${num} N obj"`);
  }
  const gen = Number(headerMatch[1]);
  if (gen !== 0) {
    throw new UnsupportedPdfError(`unsupported: object ${num} has non-zero generation ${gen}`);
  }
  let i = offset + headerMatch[0].length;
  while (/\s/.test(text[i])) i++;

  if (!text.startsWith("<<", i)) {
    // A handful of legal PDF objects are not dictionaries (an array, a
    // bare number/name — used for some /Length or /Kids-adjacent
    // objects). None of those are stream objects, so we keep their body
    // as opaque text up to `endobj` and never look inside it again.
    const endobjIdx = text.indexOf("endobj", i);
    if (endobjIdx === -1) throw new UnsupportedPdfError(`object ${num}: no endobj found`);
    return { num, gen, isStream: false, dictText: text.slice(i, endobjIdx).trim() };
  }

  const dictEnd = findMatchingDictEnd(text, i);
  const dictText = text.slice(i, dictEnd);
  let j = dictEnd;
  while (/\s/.test(text[j])) j++;

  if (!text.startsWith("stream", j)) {
    return { num, gen, isStream: false, dictText };
  }

  j += "stream".length;
  // Per spec, `stream` is followed by CRLF or bare LF (never a bare CR).
  if (text[j] === "\r" && text[j + 1] === "\n") j += 2;
  else if (text[j] === "\n") j += 1;
  else throw new UnsupportedPdfError(`object ${num}: "stream" not followed by CRLF/LF`);

  const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictText);
  const indirectLength = /\/Length\s+\d+\s+\d+\s+R/.exec(dictText);
  if (indirectLength) {
    throw new UnsupportedPdfError(`object ${num}: /Length is an indirect reference, which is unsupported`);
  }
  if (!lengthMatch) {
    throw new UnsupportedPdfError(`object ${num}: stream has no direct /Length`);
  }
  const length = Number(lengthMatch[1]);
  const streamBytes = text.slice(j, j + length);
  let k = j + length;
  while (/\s/.test(text[k])) k++;
  if (!text.startsWith("endstream", k)) {
    throw new UnsupportedPdfError(`object ${num}: /Length does not land on "endstream"`);
  }

  return { num, gen, isStream: true, dictText, streamBytes };
}

function parsePdf(fileBytes) {
  const text = bytesToLatin1(fileBytes);
  const { size, rootNum, entries, extraTrailerEntries } = parseXrefAndTrailer(text);

  const objects = new Map();
  for (let num = 1; num < size; num++) {
    const entry = entries[num];
    if (!entry || !entry.inUse) {
      throw new UnsupportedPdfError(`unsupported: object ${num} is free-listed (no object streams/gaps supported)`);
    }
    objects.set(num, parseObjectAt(text, num, entry.offset));
  }

  return { size, rootNum, extraTrailerEntries, objects };
}

// =====================================================================
// Page tree walking — find which objects are page content streams, and
// which fonts they use (to reject composite/CID fonts).
// =====================================================================

function getDict(pdf, ref) {
  const obj = pdf.objects.get(ref);
  if (!obj) throw new UnsupportedPdfError(`dangling reference to object ${ref}`);
  return obj;
}

function parseRefArray(arrayText) {
  const refs = [];
  const re = /(\d+)\s+(\d+)\s+R/g;
  let m;
  while ((m = re.exec(arrayText)) !== null) refs.push(Number(m[1]));
  return refs;
}

/** Finds the bracketed `[...]` value of a `/Key` in a dict's text. */
function findArrayValue(dictText, key) {
  const m = new RegExp(`/${key}\\s*\\[`).exec(dictText);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let i = start;
  while (i < dictText.length) {
    if (dictText[i] === "[") depth++;
    else if (dictText[i] === "]") {
      depth--;
      if (depth === 0) return dictText.slice(start, i + 1);
    }
    i++;
  }
  throw new UnsupportedPdfError(`unterminated array for /${key}`);
}

function collectFontSubtypes(pdf, dictText, subtypes) {
  const resourcesRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(dictText);
  let resourcesDict = dictText;
  if (resourcesRef) {
    resourcesDict = getDict(pdf, Number(resourcesRef[1])).dictText;
  } else {
    const inline = /\/Resources\s*<</.exec(dictText);
    if (!inline) return; // no resources on this page/node — nothing to check
    const start = dictText.indexOf("<<", inline.index);
    resourcesDict = dictText.slice(start, findMatchingDictEnd(dictText, start));
  }

  const fontRef = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resourcesDict);
  let fontDict = null;
  if (fontRef) {
    fontDict = getDict(pdf, Number(fontRef[1])).dictText;
  } else {
    const inline = /\/Font\s*<</.exec(resourcesDict);
    if (inline) {
      const start = resourcesDict.indexOf("<<", inline.index);
      fontDict = resourcesDict.slice(start, findMatchingDictEnd(resourcesDict, start));
    }
  }
  if (!fontDict) return;

  const refRe = /\/\S+\s+(\d+)\s+(\d+)\s+R/g;
  let m;
  while ((m = refRe.exec(fontDict)) !== null) {
    const fontObj = getDict(pdf, Number(m[1]));
    const subtypeMatch = /\/Subtype\s*\/(\w+)/.exec(fontObj.dictText);
    if (subtypeMatch) subtypes.add(subtypeMatch[1]);
    if (/\/Differences\s*\[/.test(fontObj.dictText)) {
      throw new UnsupportedPdfError(
        "unsupported: a font resource declares /Differences (custom glyph re-encoding) — " +
          "this script cannot safely assume Tj string bytes are readable text",
      );
    }
  }
}

/** Walks Root -> Pages -> Kids* -> Page leaves, returning content stream object numbers per leaf. */
function findPageContentStreams(pdf) {
  const catalog = getDict(pdf, pdf.rootNum);
  const pagesRefMatch = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog.dictText);
  if (!pagesRefMatch) throw new UnsupportedPdfError("catalog has no /Pages");

  const contentStreamNums = new Set();
  const fontSubtypes = new Set();

  function walk(nodeNum) {
    const node = getDict(pdf, nodeNum);
    const kidsArray = findArrayValue(node.dictText, "Kids");
    if (kidsArray) {
      for (const kid of parseRefArray(kidsArray)) walk(kid);
      return;
    }
    // Leaf page.
    collectFontSubtypes(pdf, node.dictText, fontSubtypes);
    const contentsArray = findArrayValue(node.dictText, "Contents");
    if (contentsArray) {
      for (const ref of parseRefArray(contentsArray)) contentStreamNums.add(ref);
      return;
    }
    const singleRef = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(node.dictText);
    if (singleRef) contentStreamNums.add(Number(singleRef[1]));
    // A page with no /Contents at all (legal — a blank page) contributes nothing.
  }

  walk(Number(pagesRefMatch[1]));

  for (const subtype of fontSubtypes) {
    if (subtype === "Type0") {
      throw new UnsupportedPdfError(
        "unsupported: a page uses a composite /Type0 (CID) font — its Tj string bytes are glyph " +
          "indices, not readable text, and this script cannot safely mask them",
      );
    }
  }

  return [...contentStreamNums];
}

// =====================================================================
// Content-stream decoding (identity or FlateDecode only)
// =====================================================================

function getFilter(dictText) {
  const arrayMatch = /\/Filter\s*\[([^\]]*)\]/.exec(dictText);
  if (arrayMatch) {
    const names = arrayMatch[1].match(/\/\w+/g) ?? [];
    if (names.length === 0) return null;
    if (names.length === 1) return names[0].slice(1);
    throw new UnsupportedPdfError(`unsupported: chained filters "${arrayMatch[1].trim()}"`);
  }
  const single = /\/Filter\s*\/(\w+)/.exec(dictText);
  return single ? single[1] : null;
}

function decodeContentStream(obj) {
  const filter = getFilter(obj.dictText);
  const raw = latin1ToBytes(obj.streamBytes);
  if (filter === null) return { text: bytesToLatin1(raw), filter: null };
  if (filter === "FlateDecode") return { text: bytesToLatin1(inflateSync(raw)), filter: "FlateDecode" };
  throw new UnsupportedPdfError(`unsupported content-stream filter /${filter}`);
}

function encodeContentStream(text, filter) {
  const raw = latin1ToBytes(text);
  if (filter === null) return bytesToLatin1(raw);
  return bytesToLatin1(deflateSync(raw));
}

// =====================================================================
// PDF literal-string encode/decode (the `(...)` syntax)
// =====================================================================

const SINGLE_CHAR_ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/** Decodes a PDF literal string's inner bytes (between the parens) to text. */
function decodePdfLiteralString(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\n") {
      i += 1; // line continuation: backslash + newline produces nothing
      continue;
    }
    if (next === "\r") {
      i += raw[i + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (next in SINGLE_CHAR_ESCAPES) {
      out += SINGLE_CHAR_ESCAPES[next];
      i += 1;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let digits = next;
      let consumed = 1;
      for (let k = 2; k <= 3; k++) {
        const d = raw[i + k];
        if (d >= "0" && d <= "7") {
          digits += d;
          consumed++;
        } else break;
      }
      out += String.fromCharCode(parseInt(digits, 8) & 0xff);
      i += consumed;
      continue;
    }
    // Backslash before an unrecognised character: spec says drop the backslash.
    out += next ?? "";
    i += 1;
  }
  return out;
}

/** Mirrors make-fixtures.mjs's escapePdfString: only ( ) \ need escaping. */
function encodePdfLiteralString(text) {
  return text.replace(/([()\\])/g, "\\$1");
}

// =====================================================================
// Content-stream text scanning
// =====================================================================
//
// Finds every text-showing operation and returns it as a "run": the
// logical line of text it draws, plus the byte span that has to be
// rewritten if that text changes.
//
// Four shapes are understood, which between them cover what real invoice
// generators emit:
//
//   (lit) Tj                      one literal string
//   <48656C> Tj                   one hex string
//   (lit) '        (lit) "        the next-line shorthands (for `"` the
//                                 word/char spacing operands precede the
//                                 string, so scanning from the string is
//                                 still correct)
//   [ (a) -250 (b) ] TJ           an array of string fragments with
//                                 kerning adjustments between them
//
// The TJ array is the case that matters: it is what a generator produces
// as soon as it kerns individual glyphs, which is the normal case for a
// real invoice, and it splits one visible line across several fragments.
// The kerning numbers are horizontal spacing adjustments, not characters,
// so the LOGICAL line is the concatenation of the fragments, and that is
// what the masking pipeline sees. Otherwise a CPF split across
// `(123.456.)` `(789-01)` would never match a detector looking for a
// whole CPF - the redaction would silently miss exactly the documents it
// exists for.
//
// How a changed line is written back, and what that costs:
//
//   - A run whose text the masking pipeline did not change is emitted
//     byte-for-byte, untouched. That is the overwhelming majority of an
//     invoice, and it is why the layout survives.
//   - A run whose text DID change is replaced by a single literal string
//     (for TJ, the whole `[...]` array becomes `[(masked)]`). Intra-line
//     kerning is therefore lost - but only on the lines whose text is
//     being replaced by a marker anyway, where the original glyph spacing
//     is not something the golden set can measure. Every other line, and
//     every line's POSITION, is unaffected.
//
// Anything outside these four shapes still makes the script refuse the
// whole file rather than half-redact it.

const TEXT_SHOWING_OPS = ["Tj", "'", '"'];

function skipWhitespace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Reads the operator token starting at `i` (already past whitespace). */
function readOperator(text, i) {
  if (text[i] === "'" || text[i] === '"') return text[i];
  let j = i;
  while (j < text.length && /[A-Za-z*]/.test(text[j])) j++;
  return text.slice(i, j);
}

/** Parses a literal `(...)` string starting at `i`. Returns its end index (exclusive). */
function endOfLiteralString(text, i) {
  let depth = 1;
  let j = i + 1;
  while (j < text.length && depth > 0) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    j++;
  }
  if (depth !== 0) throw new UnsupportedPdfError("unterminated literal string in content stream");
  return j;
}

/**
 * Parses a content-stream array operand starting at `[`. Returns the index
 * just past `]` and the string fragments it contains (kerning numbers are
 * spacing, not text, and are dropped from the logical line).
 */
function parseArrayOperand(text, start) {
  const fragments = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "]") return { end: i + 1, fragments };
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      const stringEnd = endOfLiteralString(text, i);
      fragments.push({ kind: "literal", raw: text.slice(i + 1, stringEnd - 1) });
      i = stringEnd;
      continue;
    }
    if (ch === "<") {
      const hexEnd = text.indexOf(">", i);
      if (hexEnd === -1) throw new UnsupportedPdfError("unterminated hex string in content stream");
      fragments.push({ kind: "hex", raw: text.slice(i + 1, hexEnd) });
      i = hexEnd + 1;
      continue;
    }
    if (/[-+.0-9]/.test(ch)) {
      while (i < text.length && /[-+.0-9]/.test(text[i])) i++;
      continue;
    }
    throw new UnsupportedPdfError(`unsupported content stream: unexpected "${ch}" inside an array operand`);
  }
  throw new UnsupportedPdfError("unterminated array operand in content stream");
}

function scanTextRuns(streamText) {
  const runs = [];
  let i = 0;
  const n = streamText.length;

  const finishSimpleRun = (fragment, stringStart, stringEnd) => {
    const k = skipWhitespace(streamText, stringEnd);
    const op = readOperator(streamText, k);
    if (!TEXT_SHOWING_OPS.includes(op)) {
      const upcoming = streamText.slice(k, k + 12).trim();
      throw new UnsupportedPdfError(
        `unsupported content stream: a string operand is followed by "${upcoming}", ` +
          `which is not a text-showing operator this script understands`,
      );
    }
    runs.push({ kind: "simple", replaceStart: stringStart, replaceEnd: stringEnd, fragments: [fragment] });
    return k + op.length;
  };

  while (i < n) {
    const ch = streamText[i];

    if (ch === "(") {
      const stringEnd = endOfLiteralString(streamText, i);
      i = finishSimpleRun({ kind: "literal", raw: streamText.slice(i + 1, stringEnd - 1) }, i, stringEnd);
      continue;
    }

    if (ch === "<" && streamText[i + 1] === "<") {
      // An inline dictionary (marked-content property list, etc). Skip
      // it wholesale - nothing inside it is a text-showing operand.
      i = findMatchingDictEnd(streamText, i);
      continue;
    }

    if (ch === "<") {
      const hexEnd = streamText.indexOf(">", i);
      if (hexEnd === -1) throw new UnsupportedPdfError("unterminated hex string in content stream");
      i = finishSimpleRun({ kind: "hex", raw: streamText.slice(i + 1, hexEnd) }, i, hexEnd + 1);
      continue;
    }

    if (ch === "[") {
      const { end, fragments } = parseArrayOperand(streamText, i);
      if (fragments.length === 0) {
        // Not a text array - a dash pattern (`[3 3] 0 d`) or similar.
        i = end;
        continue;
      }
      const k = skipWhitespace(streamText, end);
      const op = readOperator(streamText, k);
      if (op !== "TJ") {
        const upcoming = streamText.slice(k, k + 12).trim();
        throw new UnsupportedPdfError(
          `unsupported content stream: an array of strings is followed by "${upcoming}" instead of TJ`,
        );
      }
      runs.push({ kind: "array", replaceStart: i, replaceEnd: end, fragments });
      i = k + op.length;
      continue;
    }

    i++;
  }
  return runs;
}

/** Decodes a hex string's inner text (`<48656C6C6F>` becomes `Hello`). */
function decodePdfHexString(raw) {
  const digits = raw.replace(/\s+/g, "");
  if (!/^[0-9A-Fa-f]*$/.test(digits)) {
    throw new UnsupportedPdfError("malformed hex string in content stream");
  }
  // An odd number of digits is padded with a trailing zero (PDF 32000-1 7.3.4.3).
  const padded = digits.length % 2 === 1 ? digits + "0" : digits;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

/** The logical line a run draws: its fragments decoded and concatenated. */
function decodeRun(run) {
  let out = "";
  for (const fragment of run.fragments) {
    out += fragment.kind === "hex" ? decodePdfHexString(fragment.raw) : decodePdfLiteralString(fragment.raw);
  }
  return out;
}

// =====================================================================
// PII masking pipeline (operates on one decoded line of text at a time —
// each Tj call in these PDFs carries exactly one line, so "line" and
// "one Tj string" coincide; nothing here reorders or merges lines, which
// is what keeps every OTHER line's position untouched).
// =====================================================================

const NAME_LABEL_RE =
  /^(\s*(?:Nome(?:\s+do\s+Cliente|\s+Completo)?|Cliente|Titular|Raz[ãa]o\s+Social)\s*:?\s*)(.+?)(?=\s*(?:CPF|CNPJ|Endere[çc]o|CEP|Telefone|Linha)\b|$)/i;

function maskLabeledName(line, report) {
  const m = NAME_LABEL_RE.exec(line);
  if (!m || !m[2].trim()) return line;
  report.name += 1;
  return line.slice(0, m.index) + m[1] + "[NOME]" + line.slice(m.index + m[0].length);
}

// Mirrors CNPJ_SOURCE's *shape* from packages/core/src/invoice/mask.ts —
// shape only. It cannot decide PII-ness by itself (no check-digit logic,
// no money/label context), so it can never disagree with core about
// what IS a CNPJ — it only proposes candidates, and `containsPii`
// (evaluated on the candidate in isolation) has the only vote. Isolating
// the candidate means the money-prefix/label-override context in core's
// `isDocumentNumber` never sees the surrounding line; that only makes
// this UNDER-protect in a vanishingly rare edge case (a coincidentally
// check-digit-valid 14-digit run that was actually something else), and
// under-protecting a non-CNPJ number is the safe direction here — it
// would simply take the normal CPF/other rules afterwards instead.
// Imported rather than re-typed: a second hand-written copy of this shape
// is exactly how a detector and its redactor drift apart, which this
// repository has already had happen once.
const CNPJ_SHAPE = new RegExp(CNPJ_SHAPE_SOURCE, "g");

function protectCnpjSpans(line, preserved) {
  const spans = [];
  const protectedLine = line.replace(CNPJ_SHAPE, (match) => {
    if (!containsPii(match)) return match;
    preserved.push(match);
    const token = `_CNPJ_KEEP_${spans.length}`;
    spans.push({ token, original: match });
    return token;
  });
  return { protectedLine, spans };
}

function restoreCnpjSpans(line, spans) {
  let result = line;
  for (const { token, original } of spans) {
    if (!result.includes(token)) {
      throw new Error(`internal error: lost the placeholder for a preserved CNPJ ("${original}")`);
    }
    result = result.replace(token, original);
  }
  return result;
}

// Heuristic only — no check digit exists for a phone number. Deliberately
// tuned (empirically, against CPF/CNPJ/CEP/date/money/barcode samples) to
// avoid firing on those denser numeric shapes; it can still over- or
// under-match a real line number. See the module header.
const PHONE_RE = /(?<!\d)(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}(?!\d)/g;

function maskPhoneNumbers(line, report) {
  return line.replace(PHONE_RE, (match) => {
    report.phone += 1;
    return "[TELEFONE]";
  });
}

function maskLine(originalLine, report, preservedCnpjs) {
  const named = maskLabeledName(originalLine, report);
  const { protectedLine, spans } = protectCnpjSpans(named, preservedCnpjs);
  const phoneHandled = maskPhoneNumbers(protectedLine, report);
  const before = phoneHandled;
  const coreMasked = maskText(phoneHandled);
  if (coreMasked !== before) {
    report.core += 1;
  }
  return restoreCnpjSpans(coreMasked, spans);
}

// =====================================================================
// Putting it together: rewrite each page content stream in place.
// =====================================================================

function anonymizeContentStreamText(streamText, report, preservedCnpjs) {
  const runs = scanTextRuns(streamText);
  let out = "";
  let cursor = 0;
  let changed = false;
  for (const run of runs) {
    const decoded = decodeRun(run);
    const masked = maskLine(decoded, report, preservedCnpjs);
    out += streamText.slice(cursor, run.replaceStart);
    if (masked !== decoded) {
      changed = true;
      const literal = "(" + encodePdfLiteralString(masked) + ")";
      // A changed TJ array collapses to a single fragment: the kerning
      // adjustments described spacing between glyphs that are no longer
      // there. See the scanner's header for why that is the right trade.
      out += run.kind === "array" ? "[" + literal + "]" : literal;
    } else {
      out += streamText.slice(run.replaceStart, run.replaceEnd);
    }
    cursor = run.replaceEnd;
  }
  out += streamText.slice(cursor);
  return { text: out, changed };
}

function setDictLength(dictText, newLength) {
  return dictText.replace(/\/Length\s+\d+/, `/Length ${newLength}`);
}

/**
 * Runs the full anonymisation in memory and returns the new PDF bytes
 * plus a report of what was masked. Throws `UnsupportedPdfError` for any
 * PDF shape outside what this script understands, and a plain `Error` if
 * its own self-verification (re-reading the output with the real unpdf
 * reader) finds something wrong — in both cases nothing is written.
 */
export async function anonymizePdf(inputBytes) {
  const pdf = parsePdf(inputBytes);
  const contentStreamNums = findPageContentStreams(pdf);

  const report = { name: 0, phone: 0, core: 0, pagesWithChanges: 0 };
  // Populated in-place by protectCnpjSpans (via maskLine) as the real
  // masking pass runs, so this is exactly the set of CNPJ substrings this
  // run actually chose to preserve — not a second, separately-derived
  // guess that could disagree with what the masking pass really did.
  const preservedCnpjs = [];
  let anyChange = false;

  const rewritten = new Map();
  for (const num of contentStreamNums) {
    const obj = pdf.objects.get(num);
    const { text: decoded, filter } = decodeContentStream(obj);
    const lineReport = { name: 0, phone: 0, core: 0 };

    const { text: newText, changed } = anonymizeContentStreamText(decoded, lineReport, preservedCnpjs);

    report.name += lineReport.name;
    report.phone += lineReport.phone;
    report.core += lineReport.core;

    if (changed) {
      anyChange = true;
      report.pagesWithChanges += 1;
      const newStreamBytes = encodeContentStream(newText, filter);
      const newDictText = setDictLength(obj.dictText, latin1ToBytes(newStreamBytes).length);
      rewritten.set(num, { ...obj, dictText: newDictText, streamBytes: newStreamBytes });
    }
  }

  if (!anyChange) {
    // Nothing to change anywhere in the document: hand back the original
    // bytes verbatim rather than reassembling. This guarantees the "no
    // PII at all" case is not just equivalent but byte-identical, and it
    // sidesteps any risk of this script's own writer introducing an
    // incidental difference in a file it never needed to touch.
    return { bytes: Buffer.from(inputBytes), report };
  }

  const outputBytes = reassemble(pdf, rewritten);
  await verifyOutput(inputBytes, outputBytes, preservedCnpjs);
  return { bytes: outputBytes, report };
}

function reassemble(pdf, rewritten) {
  const chunks = ['%PDF-1.4\n'];
  const offsets = new Map();
  let offset = chunks[0].length;

  for (let num = 1; num < pdf.size; num++) {
    const obj = rewritten.get(num) ?? pdf.objects.get(num);
    offsets.set(num, offset);
    let body;
    if (obj.isStream) {
      body = `${num} 0 obj\n${obj.dictText}\nstream\n${obj.streamBytes}\nendstream\nendobj\n`;
    } else {
      body = `${num} 0 obj\n${obj.dictText}\nendobj\n`;
    }
    chunks.push(body);
    offset += body.length;
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${pdf.size}\n0000000000 65535 f \n`;
  for (let num = 1; num < pdf.size; num++) {
    xref += `${String(offsets.get(num)).padStart(10, "0")} 00000 n \n`;
  }
  const trailerExtra = pdf.extraTrailerEntries ? ` ${pdf.extraTrailerEntries}` : "";
  const trailer = `trailer\n<< /Size ${pdf.size} /Root ${pdf.rootNum} 0 R${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF`;

  chunks.push(xref, trailer);
  return latin1ToBytes(chunks.join(""));
}

/**
 * Self-verification (per the E1 task brief: "packages/adapters exports
 * createUnpdfReader ... use it to verify your own output"). Reads the
 * output back with the real reader used in production and checks:
 *  - the page count did not change;
 *  - after removing the CNPJ(s) this run deliberately preserved, no PII
 *    the real detector recognises remains — i.e. no leftover CPF,
 *    address, CEP, barcode or digitable line survived the rewrite.
 * This does NOT (cannot) verify the name/phone heuristics, which have no
 * independent detector to check against — see the module header.
 */
function verifyOutput(inputBytes, outputBytes, preservedCnpjs) {
  const reader = createUnpdfReader();
  // unpdf insists on a plain Uint8Array, not a Node Buffer (a Uint8Array
  // subclass) — readFileSync and this script's own Buffer-returning
  // helpers both hand back Buffers, so normalise explicitly here.
  const before$ = reader.read(new Uint8Array(inputBytes));
  const after$ = reader.read(new Uint8Array(outputBytes));
  return Promise.all([before$, after$]).then(([before, after]) => {
    if (before.pageCount !== after.pageCount) {
      throw new Error(`self-check failed: page count changed (${before.pageCount} -> ${after.pageCount})`);
    }
    for (const page of after.pages) {
      let stripped = page;
      for (const cnpj of preservedCnpjs) {
        stripped = stripped.replace(cnpj, "");
      }
      if (containsPii(stripped)) {
        throw new Error(
          "self-check failed: the anonymised output still contains PII the core detector recognises " +
            "(after excluding the CNPJ(s) this run deliberately preserved)",
        );
      }
    }
  });
}

// =====================================================================
// CLI
// =====================================================================

async function main() {
  const [inputPath, outputDir] = process.argv.slice(2);
  if (!inputPath || !outputDir) {
    console.error("usage: pnpm golden:anonymize <input.pdf> <output-dir>");
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    const inputBytes = readFileSync(resolve(inputPath));
    result = await anonymizePdf(inputBytes);
  } catch (err) {
    console.error(`golden:anonymize failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const outDir = resolve(outputDir);
  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, "source.pdf");
  writeFileSync(outputPath, result.bytes);

  const { report } = result;
  console.log(`wrote ${outputPath}`);
  console.log(
    `masked: ${report.core} CPF/address/CEP/other-core span(s), ${report.name} name label(s), ${report.phone} phone-shaped number(s)`,
  );
  console.log(
    "WARNING: name and phone/line-number masking are unvalidated heuristics (no check digit, label-based only) " +
      "— manually inspect source.pdf before trusting it in the golden set. See this script's header comment.",
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
