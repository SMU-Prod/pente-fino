import { Buffer } from "node:buffer";
import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentReader, ReadDocument } from "@pentefino/core/ports";

/**
 * Matches an indirect object's `/Type /Page` declaration - a leaf page, not
 * a `/Pages` tree node - allowing the whitespace-free form (`/Type/Page`)
 * that PDF syntax permits between two tokens that each start with a `/`
 * delimiter. The negative lookahead is what excludes `/Pages`: without it,
 * `/Type /Page` also matches as a prefix of `/Type /Pages`.
 */
const LEAF_PAGE_OBJECT = /\/Type\s*\/Page(?![A-Za-z])/g;

/**
 * Counts `/Type /Page` declarations directly in the PDF's own bytes,
 * independent of what any `/Pages` node's `/Count` claims. See the doc
 * comment on `createUnpdfReader` for why this exists.
 */
function countLeafPageObjects(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  return text.match(LEAF_PAGE_OBJECT)?.length ?? 0;
}

/**
 * Reads a PDF's text with unpdf, which is a library and not a service - it
 * needs no account, which is what lets the whole extraction path be built
 * and tested before any credential exists.
 *
 * A page whose text is whitespace only is kept as an empty string rather
 * than dropped, so `pages[i]` always refers to page i+1 and the per-page
 * density signal of the quality score stays meaningful.
 *
 * ## Why this cross-checks /Count against the raw bytes
 *
 * pdf.js resolves a document's page count from the `/Count` field its page
 * tree declares - it does not walk the tree to verify that number. A PDF
 * whose top-level `/Pages` node says `/Count 12` while its `/Kids` array
 * actually lists 13 pages reports `pageCount: 12` here: the thirteenth
 * page is never fetched, never extracted, and never mentioned - a silent
 * drop of whatever charges happen to sit on it, which is the one thing an
 * invoice auditor cannot do (A8).
 *
 * The obvious probe - ask the proxy `getDocumentProxy` returns for page
 * N+1 and see whether it exists - does not work, and this was verified
 * against the exact unpdf/pdf.js build this package pins rather than
 * assumed. `PDFDocumentProxy.getPage` bounds-checks the requested index
 * against its own cached page count *before* it asks the document for
 * anything, so it rejects with "Invalid page request." for index N+1 on
 * every PDF whose declared count is N - the truncated ones and the
 * honestly-N-page ones alike. It is a check against the same number we do
 * not trust, so it can never disagree with itself. Bypassing that guard
 * does not help either (confirmed the same way): pdf.js's own page-tree
 * walker treats each `/Pages` node's declared `/Count` as a skip-ahead
 * shortcut - "this subtree claims 12 pages, the one I want is past all of
 * them, skip the whole subtree" - so a wrong top-level `/Count` stops the
 * walk from ever reaching the thirteenth `/Kids` entry, even when it is
 * asked for directly. pdf.js can and does self-heal the opposite mistake -
 * a declared count that is too HIGH, where the last declared page fails to
 * load - by falling back to a real, `/Count`-ignoring walk of its own
 * (`Catalog#getAllPageDicts`, invoked automatically from `checkLastPage`
 * at load time; see the over-declaring test below). But that machinery
 * only fires when the last declared page is missing, is not reachable from
 * outside pdf.js's own document loader, and has nothing to trigger it when
 * every declared page loads fine and the excess page is simply never asked
 * for - which is exactly the under-declared case.
 *
 * So this reader checks the one thing it still has: the raw bytes it was
 * already handed. `countLeafPageObjects` counts indirect objects declaring
 * `/Type /Page` directly in those bytes. A real invoice's page objects are
 * not usually compressed into an object stream, so this catches the
 * ordinary under-count with certainty. A page object that IS compressed
 * that way would not be counted, and a file relying on that to under-report
 * its count would slip past this check exactly as it does today - a real
 * gap, named here rather than hidden, and not one worth closing by
 * reimplementing pdf.js's own object-stream decompression just to
 * second-guess pdf.js. What this check does see, it fails loudly on,
 * naming both counts, rather than silently returning fewer pages than the
 * file has.
 */
export function createUnpdfReader(): DocumentReader {
  return {
    async read(bytes: Uint8Array): Promise<ReadDocument> {
      // Counted before handing `bytes` to pdf.js: `getDocumentProxy` posts the
      // buffer to its (in-process, for Node) worker as a transferable, which
      // detaches it - reading `bytes` afterward would see a zero-length
      // buffer, always agreeing with whatever pdf.js reports and silently
      // disabling this whole check.
      const leafPageObjects = countLeafPageObjects(bytes);

      const pdf = await getDocumentProxy(bytes);
      const { totalPages, text } = await extractText(pdf, { mergePages: false });

      if (leafPageObjects > totalPages) {
        throw new Error(
          `PDF page tree declares ${totalPages} page(s) but its bytes contain ` +
            `${leafPageObjects} object(s) declaring /Type /Page; refusing to read ` +
            "a document whose page count cannot be trusted",
        );
      }

      const pages = (Array.isArray(text) ? text : [text]).map((page) => page.trim());
      return {
        pages,
        pageCount: totalPages,
        hasTextLayer: pages.some((page) => page.length > 0),
      };
    },
  };
}
