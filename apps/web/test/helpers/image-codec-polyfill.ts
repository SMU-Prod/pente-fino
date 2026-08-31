import { Canvas, loadImage } from "@napi-rs/canvas";

/**
 * Stands in for the two browser APIs `prepareImage` (lib/image/prepare.ts)
 * needs and Node does not have: `createImageBitmap` and `OffscreenCanvas`.
 *
 * Backed by `@napi-rs/canvas` — a real Rust/Skia decoder+encoder exposed to
 * Node via napi bindings, not a hand-rolled stub. It genuinely parses
 * JPEG/PNG bytes (real libjpeg/libpng-equivalent codecs) and genuinely
 * re-encodes JPEG, so the resize math, the EXIF-orientation canvas
 * transform, and the produced JPEG's magic bytes/pixel content that
 * `image-prepare.test.ts` asserts on are checked against a real decode and a
 * real encode, not against a fake that is wired to say whatever the test
 * wants to hear. Confirmed directly: decoding a deliberately-corrupt buffer
 * and a HEIC-labelled buffer through this same path both reject with
 * "Unsupported image type" — there's a real codec underneath that can fail.
 *
 * What this honestly does NOT prove, and must not be read into the tests
 * that use it:
 *
 *  - Nothing about actual browser behavior. `createImageBitmap`'s exact
 *    rejection shape and `OffscreenCanvas.convertToBlob`'s exact encoder
 *    output are Chromium/WebKit/Gecko implementation details this polyfill
 *    does not reproduce — it only has to satisfy the same *call shape*
 *    prepare.ts uses. `convertToBlob`'s Web-spec option key is `type`; the
 *    underlying @napi-rs/canvas method's is `mime` (confirmed by hand:
 *    passing `type` straight through silently produces a PNG, not the
 *    requested JPEG) — translated below so prepare.ts itself only ever has
 *    to speak the real `OffscreenCanvas` vocabulary, not this shim's.
 *  - That `imageOrientation: "from-image"` is doing anything. The
 *    `createImageBitmap` stand-in below ignores its `options` argument
 *    entirely — `@napi-rs/canvas`'s decoder has no concept of it and
 *    *always* auto-applies a JPEG's EXIF orientation (confirmed by hand: a
 *    hand-built APP1/orientation=6 fixture decodes with dimensions already
 *    swapped and pixels already rotated). That happens to be exactly the
 *    behavior prepare.ts asks for by name, so the orientation-6 test is
 *    real evidence that *given* an auto-orienting decoder, prepare.ts's
 *    resize/re-encode math around it is correct. It is not evidence that
 *    passing `"from-image"` was the right thing to request, nor of what an
 *    orientation other than 6 does, nor of what requesting `"none"` would
 *    have looked like — none of that can be observed through this decoder.
 *  - HEIC support. @napi-rs/canvas ships no HEIC codec at all — every HEIC
 *    decode attempt rejects, full stop. That happens to line up with
 *    Chromium/Firefox's real lack of a HEIC decoder, but it is a
 *    coincidence of which codecs this library links in, not a simulation of
 *    "which browsers support HEIC." Safari/WebKit's OS-level HEIC decoder
 *    (the one real path that would actually succeed) is never exercised by
 *    this test file, by construction — see the HEIC test's own comment.
 *  - Anything about performance, memory, or `ImageBitmap.close()` actually
 *    releasing a resource — it is a no-op here.
 */
export function installBrowserImageCodecPolyfill(): void {
  const globals = globalThis as unknown as {
    OffscreenCanvas: unknown;
    createImageBitmap: unknown;
  };

  globals.OffscreenCanvas = OffscreenCanvasPolyfill;
  globals.createImageBitmap = async (source: Blob): Promise<ImageBitmap> => {
    const buffer = Buffer.from(await source.arrayBuffer());
    const image = await loadImage(buffer);
    // Real ImageBitmap.close() frees GPU/decode resources. @napi-rs/canvas's
    // Image has no equivalent; prepare.ts calls close() unconditionally (as
    // real browser code should), so the polyfill result needs the method to
    // exist, even as a no-op.
    return Object.assign(image, { close: () => {} }) as unknown as ImageBitmap;
  };
}

/**
 * Composition, not subclassing: `@napi-rs/canvas`'s `Canvas` assigns its
 * methods as own instance properties in its (native) constructor, which
 * shadow anything a subclass puts on the prototype — an override method on
 * a `class extends Canvas` is silently never called. Wrapping an inner
 * `Canvas` sidesteps that entirely.
 */
class OffscreenCanvasPolyfill {
  readonly #inner: Canvas;

  constructor(width: number, height: number) {
    this.#inner = new Canvas(width, height);
  }

  getContext(contextId: "2d") {
    return this.#inner.getContext(contextId);
  }

  convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    // `exactOptionalPropertyTypes` forbids assigning `undefined` into an
    // optional property outright, so the key is only ever set when there is
    // a real value for it — @napi-rs/canvas's own `ConvertToBlobOptions`
    // types `mime`/`quality` as plain `string`/`number` (no `| undefined`).
    const napiOptions: { mime?: string; quality?: number } = {};
    if (options?.type !== undefined) napiOptions.mime = options.type;
    if (options?.quality !== undefined) napiOptions.quality = options.quality;
    return this.#inner.convertToBlob(napiOptions);
  }
}
