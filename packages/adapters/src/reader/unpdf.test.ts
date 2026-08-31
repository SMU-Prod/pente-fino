import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createUnpdfReader } from "./unpdf.js";

function fixture(name: string): Uint8Array {
  const path = fileURLToPath(
    new URL(`../../../../fixtures/synthetic/pdfs/${name}`, import.meta.url),
  );
  return new Uint8Array(readFileSync(path));
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
