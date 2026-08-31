import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentReader, ReadDocument } from "@pentefino/core/ports";

/**
 * Reads a PDF's text with unpdf, which is a library and not a service - it
 * needs no account, which is what lets the whole extraction path be built
 * and tested before any credential exists.
 *
 * A page whose text is whitespace only is kept as an empty string rather
 * than dropped, so `pages[i]` always refers to page i+1 and the per-page
 * density signal of the quality score stays meaningful.
 */
export function createUnpdfReader(): DocumentReader {
  return {
    async read(bytes: Uint8Array): Promise<ReadDocument> {
      const pdf = await getDocumentProxy(bytes);
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const pages = (Array.isArray(text) ? text : [text]).map((page) => page.trim());
      return {
        pages,
        pageCount: totalPages,
        hasTextLayer: pages.some((page) => page.length > 0),
      };
    },
  };
}
