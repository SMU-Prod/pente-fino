import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createUnpdfReader } from "./unpdf.js";

function fixture(name: string): Uint8Array {
  const path = fileURLToPath(
    new URL(`../../../../fixtures/synthetic/pdfs/${name}`, import.meta.url),
  );
  return new Uint8Array(readFileSync(path));
}

/**
 * Rewrites a fixture's declared `/Count` in memory, byte-for-byte identical
 * otherwise. `from` and `to` must render to the same number of digits: the
 * xref offsets later in the file are byte-exact and changing the file's
 * length would desync every one of them, the same constraint the
 * fixture-generation script documents for its own hand-built offsets. This
 * never touches the committed fixture - `fixtures/synthetic/pdfs` holds
 * only well-formed PDFs (see its README), and a malformed one committed
 * there would be mistaken for a legitimate case - it patches a fresh copy
 * of the bytes for a single test.
 */
function patchDeclaredCount(bytes: Uint8Array, from: number, to: number): Uint8Array {
  const needle = Buffer.from(`/Count ${from}`, "latin1");
  const replacement = Buffer.from(`/Count ${to}`, "latin1");
  if (needle.length !== replacement.length) {
    throw new Error("test bug: patched /Count must keep the same byte length");
  }
  const original = Buffer.from(bytes);
  const index = original.indexOf(needle);
  if (index === -1) {
    throw new Error(`fixture does not declare ${needle.toString("latin1")}`);
  }
  const patched = Buffer.from(original);
  replacement.copy(patched, index);
  return new Uint8Array(patched);
}

describe("unpdf reader", () => {
  it("returns one entry per page", async () => {
    const doc = await createUnpdfReader().read(fixture("text-2page.pdf"));
    expect(doc.pages).toHaveLength(2);
    expect(doc.pageCount).toBe(2);
  });

  it("extracts the text that is on the page", async () => {
    const doc = await createUnpdfReader().read(fixture("text-2page.pdf"));
    expect(doc.pages.join(" ")).toContain("Claro");
    expect(doc.pages.join(" ")).toContain("129,90");
  });

  it("reports a text layer when there is one", async () => {
    const doc = await createUnpdfReader().read(fixture("text-2page.pdf"));
    expect(doc.hasTextLayer).toBe(true);
  });

  it("reports no text layer for a scan", async () => {
    const doc = await createUnpdfReader().read(fixture("scan-1page.pdf"));
    expect(doc.hasTextLayer).toBe(false);
    expect(doc.pageCount).toBe(1);
  });

  it("counts pages past the RF-104 limit rather than refusing to parse", async () => {
    const doc = await createUnpdfReader().read(fixture("text-13page.pdf"));
    expect(doc.pageCount).toBe(13);
  });

  it("rejects bytes that are not a PDF, rather than returning empty text", async () => {
    const notPdf = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    await expect(createUnpdfReader().read(notPdf)).rejects.toThrow();
  });
});

describe("unpdf reader - /Count integrity", () => {
  it("throws when the page tree under-declares its page count, naming both numbers", async () => {
    // text-13page.pdf genuinely has 13 pages; only the declared /Count is
    // lowered to 12. pdf.js would otherwise report pageCount: 12 and drop
    // the thirteenth page's text with no error - the exact defect this
    // check exists to catch.
    const patched = patchDeclaredCount(fixture("text-13page.pdf"), 13, 12);

    let error: unknown;
    try {
      await createUnpdfReader().read(patched);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/\b12\b/);
    expect(message).toMatch(/\b13\b/);
  });

  it("still reads the three honest fixtures exactly as before - the check costs nothing on a well-formed file", async () => {
    const reader = createUnpdfReader();
    const twoPage = await reader.read(fixture("text-2page.pdf"));
    const scan = await reader.read(fixture("scan-1page.pdf"));
    const thirteenPage = await reader.read(fixture("text-13page.pdf"));

    expect(twoPage.pageCount).toBe(2);
    expect(twoPage.pages).toHaveLength(2);
    expect(scan.pageCount).toBe(1);
    expect(scan.hasTextLayer).toBe(false);
    expect(thirteenPage.pageCount).toBe(13);
    expect(thirteenPage.pages).toHaveLength(13);
  });

  it("does not throw when the page tree over-declares its page count", async () => {
    // Declaring MORE pages than exist is a different failure from
    // declaring fewer, and this reader deliberately does not treat it the
    // same way. pdf.js's own loader already notices, at load time, that
    // the declared last page (the 9th, here) does not exist, and falls
    // back to a real walk of the actual /Kids tree - a walk that does not
    // trust /Count - correcting pageCount down to the true count (2)
    // before this reader ever sees the document. No content goes missing
    // and nothing needs recovering, so raising a second failure on top of
    // pdf.js's own correct self-heal would only make an already-handled
    // case noisier, not safer.
    const patched = patchDeclaredCount(fixture("text-2page.pdf"), 2, 9);

    const doc = await createUnpdfReader().read(patched);

    expect(doc.pageCount).toBe(2);
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages.join(" ")).toContain("Claro");
  });
});

describe("the reader does not consume its caller's buffer", () => {
  it("leaves the input readable after a read, so a shared fixture survives", async () => {
    const bytes = fixture("text-2page.pdf");
    const lengthBefore = bytes.length;
    const firstByte = bytes[0];

    await createUnpdfReader().read(bytes);

    expect(bytes.length).toBe(lengthBefore);
    expect(bytes[0]).toBe(firstByte);
  });

  it("reads the same buffer twice with identical results", async () => {
    const bytes = fixture("text-2page.pdf");
    const reader = createUnpdfReader();

    const first = await reader.read(bytes);
    const second = await reader.read(bytes);

    expect(second.pageCount).toBe(first.pageCount);
    expect(second.pages).toEqual(first.pages);
  });
});
