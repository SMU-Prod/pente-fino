/**
 * RF-103: client-side image preparation, before the upload — a photographed
 * invoice is resized to 2000 px on its longest side, HEIC is converted to
 * JPEG, and rotation is corrected from EXIF, all before a single byte
 * crosses the network.
 *
 * Runs entirely in the browser on standard Web APIs (`createImageBitmap`,
 * `OffscreenCanvas`) — no Node built-ins, so this module is safe to import
 * from a client component. See `test/helpers/image-codec-polyfill.ts` for
 * how this is exercised under Node, and exactly what that does and does not
 * prove.
 *
 * HEIC reality: browsers largely do not carry a HEIC decoder. Chromium and
 * Firefox have none; `createImageBitmap` on a HEIC file rejects on both.
 * Safari (macOS/iOS) is the one real exception — WebKit hands image
 * decoding to the OS's ImageIO framework, which does understand HEIC, and
 * that happens to cover the dominant real-world source of HEIC photos
 * (iPhone camera → Mobile Safari, or any other browser on iOS, since Apple
 * requires them all to run on WebKit). This module does not carry — and
 * cannot honestly carry, without a HEIC decoder dependency this task was not
 * asked to add — a JavaScript fallback decoder for the browsers that lack
 * one. It always attempts the real decode rather than branching on the
 * declared MIME type, so it converts HEIC wherever the browser can actually
 * open it, and it fails with `ImageDecodeError` (never a silent pass-through
 * and never a fabricated "converted" result) wherever it can't. The caller
 * is expected to catch that and tell the user to retry from Safari or send
 * a JPEG/PNG/PDF instead.
 */

const MAX_DIMENSION = 2000;
const OUTPUT_MIME = "image/jpeg";
const JPEG_QUALITY = 0.85;

const ACCEPTED_INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/heic"]);

export interface PreparedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * `file.type` was not one of RF-104's image types (`image/jpeg`,
 * `image/png`, `image/heic`). PDFs and anything else never reach this
 * function — they go through the document pipeline instead.
 */
export class UnsupportedImageTypeError extends Error {
  readonly code = "unsupported_type";
  readonly mimeType: string;

  constructor(mimeType: string) {
    super(`prepareImage: unsupported type "${mimeType || "(empty)"}" — expected image/jpeg, image/png or image/heic.`);
    this.name = "UnsupportedImageTypeError";
    this.mimeType = mimeType;
  }
}

/**
 * The browser accepted the file's declared type but could not decode its
 * bytes. Expected and common for HEIC outside Safari/WebKit — see the
 * module-level HEIC note above.
 */
export class ImageDecodeError extends Error {
  readonly code = "image_decode_failed";
  readonly mimeType: string;

  constructor(mimeType: string, cause: unknown) {
    super(
      mimeType === "image/heic"
        ? "prepareImage: could not decode this HEIC photo. Chromium and Firefox have no built-in HEIC "
          + "decoder — only Safari/WebKit (macOS and iOS, where HEIC photos usually come from) can open "
          + "one. Ask the user to retry from Safari, or to send a JPEG, PNG or PDF instead."
        : `prepareImage: could not decode this ${mimeType} file.`,
      { cause },
    );
    this.name = "ImageDecodeError";
    this.mimeType = mimeType;
  }
}

type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Reads the EXIF `Orientation` tag (0x0112) straight out of a JPEG's APP1
 * segment. Returns 1 (normal) for anything that isn't a well-formed JPEG
 * APP1/Exif/TIFF chain — a missing or malformed segment is not this
 * function's problem to solve, and treating it as "no rotation needed" is a
 * far safer failure mode than throwing and failing the whole upload over a
 * metadata quirk.
 *
 * This value does not drive any rotation math here — `createImageBitmap`
 * below is asked for `imageOrientation: "from-image"`, so the browser's own
 * (spec-mandated, far better tested) EXIF handling does the actual
 * rotating, and `bitmap.width`/`bitmap.height` already come back correctly
 * oriented. This function exists only to answer one question: does the
 * *source* file need its pixels re-encoded at all to be upright, or is it
 * already stored correctly-oriented (`orientation === 1`)? That decision
 * feeds the re-encode/pass-through choice below.
 *
 * Only called for `image/jpeg` inputs. HEIC carries orientation in a
 * completely different (ISOBMFF box) container that this does not parse —
 * see the module-level HEIC note.
 */
function readJpegOrientation(buffer: ArrayBuffer): ExifOrientation {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break; // not a marker: malformed, stop
    if (marker === 0xffda) break; // start of scan: no more markers follow

    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1 && offset + 4 + 6 <= view.byteLength) {
      const exifStart = offset + 4;
      const isExif = view.getUint32(exifStart) === 0x45786966 // "Exif"
        && view.getUint16(exifStart + 4) === 0x0000;
      if (isExif) {
        const orientation = readOrientationFromTiff(view, exifStart + 6);
        if (orientation) return orientation;
      }
    }
    offset += 2 + length;
  }
  return 1;
}

function readOrientationFromTiff(view: DataView, tiffStart: number): ExifOrientation | null {
  if (tiffStart + 8 > view.byteLength) return null;
  const byteOrderMark = view.getUint16(tiffStart);
  const little = byteOrderMark === 0x4949; // "II"
  if (!little && byteOrderMark !== 0x4d4d) return null; // not "II" nor "MM"

  const ifdOffset = view.getUint32(tiffStart + 4, little);
  const ifdStart = tiffStart + ifdOffset;
  if (ifdStart + 2 > view.byteLength) return null;

  const entryCount = view.getUint16(ifdStart, little);
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdStart + 2 + i * 12;
    if (entryOffset + 10 > view.byteLength) break;
    if (view.getUint16(entryOffset, little) === 0x0112) {
      const value = view.getUint16(entryOffset + 8, little);
      return value >= 1 && value <= 8 ? (value as ExifOrientation) : null;
    }
  }
  return null;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!ACCEPTED_INPUT_TYPES.has(file.type)) {
    throw new UnsupportedImageTypeError(file.type);
  }

  const orientation = file.type === "image/jpeg" ? readJpegOrientation(await file.arrayBuffer()) : 1;

  let bitmap: ImageBitmap;
  try {
    // `imageOrientation: "from-image"` is requested explicitly rather than
    // left to whatever a given browser defaults to: it tells the decoder to
    // apply the file's own EXIF orientation, so `bitmap.width`/`.height`
    // (and its pixels) come back already upright and already swapped for a
    // 90°/270° rotation. That is real, spec-mandated browser behavior, not
    // something this module reimplements — no rotation matrix lives here.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (cause) {
    throw new ImageDecodeError(file.type, cause);
  }

  try {
    const naturalWidth = bitmap.width;
    const naturalHeight = bitmap.height;

    const scale = Math.min(1, MAX_DIMENSION / Math.max(naturalWidth, naturalHeight));
    const targetWidth = Math.max(1, Math.round(naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(naturalHeight * scale));

    // Skip the lossy re-encode when the file already is what this pipeline
    // would produce anyway: already JPEG, already upright, already within
    // the size cap. Anything else — PNG, HEIC, oversized, or rotated —
    // goes through the canvas below and comes out normalized to JPEG. PNG
    // is included in that normalization (not just HEIC) so this pipeline
    // always hands the rest of the app a single, predictable photo format.
    if (file.type === OUTPUT_MIME && orientation === 1 && scale === 1) {
      return { blob: file, mimeType: file.type, width: naturalWidth, height: naturalHeight };
    }

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageDecodeError(file.type, new Error("2d canvas context unavailable"));

    // `bitmap` is already correctly oriented, so this is a plain scaled
    // draw — no transform math needed on top of it.
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const blob = await canvas.convertToBlob({ type: OUTPUT_MIME, quality: JPEG_QUALITY });
    return { blob, mimeType: OUTPUT_MIME, width: targetWidth, height: targetHeight };
  } finally {
    bitmap.close();
  }
}
