/**
 * Reads a stored document into text, without judging any of it (A1).
 *
 * `pages` carries one entry per page, in order, so a page count and a
 * per-page text density are both derivable without a second parse.
 * `hasTextLayer` is false for a scan: a PDF whose pages are images has a
 * page count but no extractable text, and that distinction is what RF-107
 * routes on.
 */
export type ReadDocument = {
  pages: string[];
  pageCount: number;
  hasTextLayer: boolean;
};

export type DocumentReader = {
  read(bytes: Uint8Array): Promise<ReadDocument>;
};
