import { Canvas } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";
import { installBrowserImageCodecPolyfill } from "./helpers/image-codec-polyfill.js";

// Must run before importing the module under test: prepare.ts reaches for
// `createImageBitmap`/`OffscreenCanvas` at call time, not at import time, but
// installing the polyfill here (rather than inside a test) keeps every test
// below honest about why it can run under plain Node at all. See
// test/helpers/image-codec-polyfill.ts for exactly what this does and does
// not prove — in short: a real decode/encode via @napi-rs/canvas (Rust/Skia
// over napi), not a stub, but not a real browser either.
beforeAll(() => {
  installBrowserImageCodecPolyfill();
});

const { prepareImage, ImageDecodeError, UnsupportedImageTypeError } = await import("../lib/image/prepare.js");

/** A real, decodable JPEG: `width`×`height`, left half red, right half blue. */
function buildSplitJpeg(width: number, height: number, quality = 90): Uint8Array<ArrayBuffer> {
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext("2d");
  const half = Math.round(width / 2);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, half, height);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(half, 0, width - half, height);
  // `canvas.toBuffer` returns a Node `Buffer` (`Uint8Array<ArrayBufferLike>`);
  // copied into a plain `Uint8Array` so it satisfies `BlobPart`'s narrower
  // `Uint8Array<ArrayBuffer>` below (`new File([bytes], ...)`).
  return new Uint8Array(canvas.toBuffer("image/jpeg", quality));
}

/** A real, decodable PNG: `width`×`height`, solid green. */
function buildPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

/**
 * A minimal, spec-correct JPEG APP1/Exif/TIFF segment carrying exactly one
 * IFD0 entry: tag 0x0112 (Orientation), type SHORT, value `orientation`.
 * Little-endian ("II") TIFF byte order throughout.
 */
function buildExifOrientationSegment(orientation: number): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(32);
  const view = new DataView(payload.buffer);
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // "Exif\0\0"
  const tiffStart = 6;
  view.setUint16(tiffStart, 0x4949, true); // "II"
  view.setUint16(tiffStart + 2, 42, true); // TIFF magic
  view.setUint32(tiffStart + 4, 8, true); // offset to IFD0, relative to tiffStart
  const ifdStart = tiffStart + 8;
  view.setUint16(ifdStart, 1, true); // 1 entry
  const entryStart = ifdStart + 2;
  view.setUint16(entryStart, 0x0112, true); // tag: Orientation
  view.setUint16(entryStart + 2, 3, true); // type: SHORT
  view.setUint32(entryStart + 4, 1, true); // count: 1
  view.setUint16(entryStart + 8, orientation, true); // value
  view.setUint32(entryStart + 12, 0, true); // next IFD offset: none

  const marker = new Uint8Array(4 + payload.length);
  const markerView = new DataView(marker.buffer);
  markerView.setUint16(0, 0xffe1, false); // APP1
  markerView.setUint16(2, payload.length + 2, false); // length includes itself, big-endian
  marker.set(payload, 4);
  return marker;
}

/** Splices an APP1/Exif segment right after a JPEG's SOI marker (first 2 bytes). */
function withExifOrientation(jpeg: Uint8Array<ArrayBuffer>, orientation: number): Uint8Array<ArrayBuffer> {
  const segment = buildExifOrientationSegment(orientation);
  const out = new Uint8Array(2 + segment.length + (jpeg.length - 2));
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

function jpegFile(bytes: Uint8Array<ArrayBuffer>, name = "photo.jpg"): File {
  return new File([bytes], name, { type: "image/jpeg" });
}

async function decodeJpeg(blob: Blob) {
  const { loadImage } = await import("@napi-rs/canvas");
  const buffer = Buffer.from(await blob.arrayBuffer());
  return loadImage(buffer);
}

describe("prepareImage (RF-103)", () => {
  it("caps the longest side at 2000 px and preserves the aspect ratio (landscape 12 MP)", async () => {
    // 4032x3024 is a real 12 MP, 4:3 phone-camera resolution — the exact
    // scenario RF-103's acceptance criterion names.
    const bytes = buildSplitJpeg(4032, 3024);
    const result = await prepareImage(jpegFile(bytes));

    expect(result.width).toBe(2000);
    expect(result.height).toBe(1500); // 3024 * (2000/4032), preserving 4:3
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("caps a portrait image on its height rather than its width", async () => {
    // Same 12 MP frame, rotated: now the *height* is the longest side.
    const bytes = buildSplitJpeg(3024, 4032);
    const result = await prepareImage(jpegFile(bytes));

    expect(result.height).toBe(2000);
    expect(result.width).toBe(1500);
    expect(result.width).toBeLessThan(result.height);
  });

  it("outputs JPEG even for a non-JPEG raster input (PNG)", async () => {
    const bytes = buildPng(100, 60);
    const result = await prepareImage(new File([bytes], "screenshot.png", { type: "image/png" }));

    expect(result.mimeType).toBe("image/jpeg");
    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(Array.from(outBytes.slice(0, 2))).toEqual([0xff, 0xd8]); // JPEG SOI marker
  });

  it("rotates the pixels according to EXIF orientation 6 (90° CW)", async () => {
    // 20x10 landscape, red left half / blue right half. Orientation 6 means
    // "rotate 90° clockwise to display correctly": the left edge (red) ends
    // up at the top, the right edge (blue) at the bottom, and the frame
    // becomes 10 wide x 20 tall.
    const bytes = withExifOrientation(buildSplitJpeg(20, 10, 95), 6);
    const result = await prepareImage(jpegFile(bytes));

    expect(result.width).toBe(10);
    expect(result.height).toBe(20);

    const decoded = await decodeJpeg(result.blob);
    const canvas = new Canvas(decoded.width, decoded.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(decoded, 0, 0);

    const [nearTopR] = ctx.getImageData(1, 2, 1, 1).data;
    const [, , nearBottomB] = ctx.getImageData(1, decoded.height - 2, 1, 1).data;
    expect(nearTopR).toBeGreaterThan(150); // red moved to the top
    expect(nearBottomB).toBeGreaterThan(150); // blue moved to the bottom
  });

  it("still re-encodes a rotated file even when it's already small (does not take the pass-through shortcut)", async () => {
    // Rotation itself is done by the decoder (`imageOrientation: "from-image"`
    // — see prepare.ts), not by prepareImage's own EXIF parsing, so the
    // orientation-6 test above would still pass even if `readJpegOrientation`
    // were broken: the decoder re-derives the correct rotation on its own
    // regardless. This is the test that actually exercises that parser —
    // it's the only thing standing between a small, rotated file and the
    // "already prepared, pass the original bytes straight through" shortcut.
    // A file this small with orientation 1 *does* take that shortcut (see
    // the test below); the only difference here is the EXIF tag, so if this
    // still resulted in `result.blob === file`, the file's un-rotated bytes
    // would go to upload with metadata claiming they're already correct.
    const bytes = withExifOrientation(buildSplitJpeg(20, 10, 95), 6);
    const file = jpegFile(bytes);
    const result = await prepareImage(file);

    expect(result.blob).not.toBe(file);
  });

  it("does not re-encode a file that is already small JPEG and correctly oriented", async () => {
    const bytes = buildSplitJpeg(100, 80); // well under 2000px, no EXIF at all
    const file = jpegFile(bytes);
    const result = await prepareImage(file);

    expect(result.blob).toBe(file); // same object: never touched the canvas
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(100);
    expect(result.height).toBe(80);
  });

  it("rejects a file whose declared type isn't an accepted image type", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 not really a pdf but that's not the point");
    const file = new File([pdfBytes], "invoice.pdf", { type: "application/pdf" });

    await expect(prepareImage(file)).rejects.toThrow(UnsupportedImageTypeError);
  });

  it("fails clearly on HEIC instead of claiming a conversion it cannot perform", async () => {
    // No real HEIC codec exists anywhere in this test environment — which
    // is also true of Chromium and Firefox, the browsers most of this
    // product's users are on. This test pins down that documented failure
    // mode (a clear, typed rejection) rather than pretending the decode
    // would succeed. It says nothing about the one browser that *can* open
    // HEIC (Safari/WebKit, via the OS codec) — that path has no stand-in
    // here at all; see image-codec-polyfill.ts.
    const fakeHeicBytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const file = new File([fakeHeicBytes], "photo.heic", { type: "image/heic" });

    await expect(prepareImage(file)).rejects.toThrow(ImageDecodeError);
    await expect(prepareImage(file)).rejects.toThrow(/HEIC/);
  });
});
