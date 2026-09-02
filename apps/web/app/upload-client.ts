"use client";

import { prepareImage, UnsupportedImageTypeError, ImageDecodeError } from "@/lib/image/prepare.js";

/**
 * The client half of RF-101/RF-102/RF-103: prepare the file, hash it, ask
 * for a signed URL, upload straight to storage, then start the pipeline.
 *
 * The bytes never pass through the app server — `POST /api/uploads/sign`
 * returns a URL the browser PUTs to directly, which is RF-101's acceptance
 * ("the upload request does not appear in the server logs with the file
 * body").
 */

export type UploadStep =
  | { kind: "preparing" }
  | { kind: "hashing" }
  | { kind: "uploading" }
  | { kind: "queued"; invoiceId: string }
  | { kind: "existing"; invoiceId: string };

export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/heic"];

/** RF-102's SHA-256, computed in the browser so the server never needs the bytes to dedupe. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A PDF goes up as-is. An image goes through `prepareImage` first (RF-103:
 * 2000 px on the long edge, HEIC to JPEG, EXIF rotation applied) so a 12 MP
 * phone photo does not spend the user's data allowance or hit RF-104's
 * 15 MB ceiling.
 */
async function toUploadable(file: File): Promise<{ blob: Blob; mimeType: string }> {
  if (file.type === "application/pdf") return { blob: file, mimeType: "application/pdf" };
  try {
    const prepared = await prepareImage(file);
    return { blob: prepared.blob, mimeType: prepared.mimeType };
  } catch (error) {
    if (error instanceof UnsupportedImageTypeError) {
      throw new UploadError("unsupported_type", "Esse tipo de arquivo não é aceito. Envie PDF, JPG, PNG ou HEIC.");
    }
    if (error instanceof ImageDecodeError) {
      throw new UploadError("decode_failed", "Não consegui abrir essa imagem. Tente outra foto ou o PDF da fatura.");
    }
    throw error;
  }
}

export async function uploadInvoice(
  file: File,
  onStep: (step: UploadStep) => void,
): Promise<string> {
  if (file.type && !ACCEPTED.includes(file.type)) {
    throw new UploadError("unsupported_type", "Esse tipo de arquivo não é aceito. Envie PDF, JPG, PNG ou HEIC.");
  }

  onStep({ kind: "preparing" });
  const { blob, mimeType } = await toUploadable(file);

  onStep({ kind: "hashing" });
  const bytes = await blob.arrayBuffer();
  const contentHash = await sha256Hex(bytes);

  const signed = await fetch("/api/uploads/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contentHash, mimeType, sizeBytes: blob.size }),
  });

  if (!signed.ok) {
    const body = (await signed.json().catch(() => ({}))) as { error?: string };
    throw new UploadError(body.error ?? "sign_failed", messageFor(body.error));
  }

  const { uploadUrl, invoiceId } = (await signed.json()) as { uploadUrl: string; invoiceId: string };

  onStep({ kind: "uploading" });
  const put = await fetch(uploadUrl, { method: "PUT", body: blob, headers: { "content-type": mimeType } });
  if (!put.ok) {
    throw new UploadError("upload_failed", "O envio do arquivo falhou. Tente de novo.");
  }

  // RF-102: the same file twice is the same invoice. `process` is
  // idempotent, so re-running it on an invoice that already has a report
  // costs nothing and the caller lands on the same page either way.
  const process = await fetch(`/api/invoices/${invoiceId}/process`, { method: "POST" });
  if (!process.ok && process.status !== 202) {
    throw new UploadError("process_failed", "O arquivo subiu, mas a leitura não começou. Recarregue a página.");
  }

  onStep({ kind: "queued", invoiceId });
  return invoiceId;
}

/**
 * The server's error codes, in words. Anything unmapped falls back to a
 * sentence that says what happened rather than showing a code — A8: a
 * failure is visible, and it is visible in language.
 */
function messageFor(code: string | undefined): string {
  switch (code) {
    case "file_too_large":
      return "Esse arquivo passa de 15 MB. Se for uma foto, tire outra com menos resolução.";
    case "unsupported_type":
      return "Esse tipo de arquivo não é aceito. Envie PDF, JPG, PNG ou HEIC.";
    case "rate_limited":
      return "Muitos envios seguidos. Espere um instante e tente de novo.";
    default:
      return "Não consegui iniciar o envio. Tente de novo em alguns segundos.";
  }
}
