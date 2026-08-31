import { describe, expect, it } from "vitest";
import { MAX_PAGES, sniffMimeType } from "./file-gate.js";

const bytes = (...values: number[]) => new Uint8Array([...values, ...Array(32).fill(0)]);

describe("sniffMimeType", () => {
  it("recognises a PDF", () => {
    expect(sniffMimeType(bytes(0x25, 0x50, 0x44, 0x46))).toBe("application/pdf");
  });

  it("recognises a JPEG", () => {
    expect(sniffMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });

  it("recognises a PNG", () => {
    expect(sniffMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
      .toBe("image/png");
  });

  it("recognises HEIC by its ftyp brand", () => {
    const heic = new Uint8Array([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, ...Array(20).fill(0),
    ]);
    expect(sniffMimeType(heic)).toBe("image/heic");
  });

  it("rejects a ZIP, which is what a .docx really is", () => {
    expect(sniffMimeType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
  });

  it("rejects a PDF header that is not at offset zero", () => {
    expect(sniffMimeType(bytes(0x00, 0x25, 0x50, 0x44, 0x46))).toBeNull();
  });

  it("rejects bytes too short to identify", () => {
    expect(sniffMimeType(new Uint8Array([0x25, 0x50]))).toBeNull();
  });

  it("names the RF-104 page limit", () => {
    expect(MAX_PAGES).toBe(12);
  });
});
