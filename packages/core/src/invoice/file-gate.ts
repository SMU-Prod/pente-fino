export type SniffedType =
  | "application/pdf" | "image/jpeg" | "image/png" | "image/heic";

/** RF-104. */
export const MAX_PAGES = 12;
export const MAX_BYTES = 15 * 1024 * 1024;

const SIGNATURES: Array<{ type: SniffedType; offset: number; bytes: number[] }> = [
  { type: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // ISO base media: "ftyp" at byte 4, brand at byte 8.
  { type: "image/heic", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] },
];

/**
 * Identifies a file by its actual leading bytes (RF-104), never by the
 * declared type or the extension. A `.docx` renamed to `.pdf` announces
 * itself as a PDF and starts with a ZIP header; only the bytes tell.
 */
export function sniffMimeType(bytes: Uint8Array): SniffedType | null {
  for (const { type, offset, bytes: signature } of SIGNATURES) {
    if (bytes.length < offset + signature.length) continue;
    if (signature.every((byte, index) => bytes[offset + index] === byte)) return type;
  }
  return null;
}
