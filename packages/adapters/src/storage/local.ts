import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sniffMimeType } from "@pentefino/core";
import type { SignedUpload, Storage } from "@pentefino/core/ports";

const TTL_MS = 5 * 60 * 1000;

// Content hashes are hex/base64url digests and owners are ids minted by
// newId() (nanoid's default alphabet), never arbitrary strings. Anything
// outside this set (path separators, "..", drive letters) is rejected before
// it can ever become part of a file key.
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

const UPLOAD_URL_PATTERN = /^local:\/\/(.+)\?exp=(\d+)&size=(\d+)&hash=([A-Za-z0-9_-]+)&sig=([0-9a-f]+)$/;

// Node's fs errors carry a `code` string; anything else about the shape of
// `error` is not something we want to assume.
function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function putError(
  reason: "unsigned" | "size_mismatch" | "hash_mismatch" | "unsupported_type" | "type_mismatch",
  message: string,
): Error {
  return Object.assign(new Error(message), { reason });
}

/**
 * Filesystem stand-in for R2. It signs and expires for real: a fake that
 * ignores the contract would let a broken assumption reach production the
 * day the real adapter arrives.
 */
export function createLocalStorage(options: {
  root: string;
  secret: string;
  now?: () => number;
}): Storage {
  const now = options.now ?? Date.now;
  const storageRoot = resolve(options.root);

  // What each signUpload() call promised: the size, content hash and
  // declared MIME type that a later put() for the same fileKey must actually
  // deliver. This is the in-memory equivalent of the policy a real R2
  // presigned PUT enforces through its signature - put() has no access to
  // the uploadUrl, only to the fileKey, so the promise has to be kept
  // somewhere it can look it up.
  const pendingUploads = new Map<string, { sizeBytes: number; contentHash: string; mimeType: string }>();

  function sign(fileKey: string, expiresAt: number, sizeBytes: number, contentHash: string): string {
    return createHmac("sha256", options.secret)
      .update(`${fileKey}:${expiresAt}:${sizeBytes}:${contentHash}`)
      .digest("hex");
  }

  // Every fileKey - whether minted by signUpload or handed in directly by a
  // caller - is resolved against the storage root and checked for escape.
  // ".." segments and absolute paths (including a Windows drive letter,
  // which path.resolve treats as absolute even mid-string) are rejected
  // rather than silently normalised, so a hostile key can never write or
  // read outside the storage root.
  function pathFor(fileKey: string): string {
    const target = resolve(storageRoot, fileKey);
    const rel = relative(storageRoot, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`refusing fileKey that escapes the storage root: ${fileKey}`);
    }
    return target;
  }

  return {
    async signUpload({ owner, contentHash, mimeType, sizeBytes }): Promise<SignedUpload> {
      if (!SAFE_KEY_SEGMENT.test(owner)) {
        throw new Error(`refusing unsafe owner: ${owner}`);
      }
      if (!SAFE_KEY_SEGMENT.test(contentHash)) {
        throw new Error(`refusing unsafe contentHash: ${contentHash}`);
      }
      const extension = mimeType === "application/pdf" ? "pdf" : "bin";
      // Scoped by owner (finding 1): RF-102 dedups per
      // `coalesce(user_id, session_id)`, but a bare `uploads/<hash>.<ext>`
      // key let two owners share one object on a matching hash. An E1
      // cleanup deleting one owner's expired invoice would have deleted the
      // other's file with it, and a caller who merely knew a hash - never
      // having uploaded anything - could sign for it and have ingest read
      // someone else's file into their own report. This is the key format
      // that gets baked into R2 in E1.
      const fileKey = `uploads/${owner}/${contentHash}.${extension}`;
      const expiresAt = now() + TTL_MS;
      const sig = sign(fileKey, expiresAt, sizeBytes, contentHash);
      pendingUploads.set(fileKey, { sizeBytes, contentHash, mimeType });
      return {
        fileKey,
        uploadUrl: `local://${fileKey}?exp=${expiresAt}&size=${sizeBytes}&hash=${contentHash}&sig=${sig}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async put(fileKey, body) {
      const target = pathFor(fileKey);
      const pending = pendingUploads.get(fileKey);
      if (!pending) {
        throw putError("unsigned", `refusing put for a fileKey with no signed upload: ${fileKey}`);
      }
      if (body.length !== pending.sizeBytes) {
        throw putError(
          "size_mismatch",
          `refusing put: body length ${body.length} does not match the signed size ${pending.sizeBytes}`,
        );
      }
      const actualHash = createHash("sha256").update(body).digest("hex");
      if (actualHash !== pending.contentHash) {
        throw putError(
          "hash_mismatch",
          `refusing put: body content hash does not match the signed content hash for ${fileKey}`,
        );
      }
      // RF-104's type check: the sign route only ever saw a client-declared
      // MIME type on a file it had not received yet (see the note on
      // ACCEPTED in apps/web/app/api/uploads/sign/route.ts). Here the real
      // bytes exist, so this is the one place that can tell a renamed
      // .docx (a ZIP header) or a JPEG-with-a-fake-PDF-extension from what
      // it actually is - never trusting the declared mimeType again.
      const sniffed = sniffMimeType(body);
      if (sniffed === null) {
        throw putError(
          "unsupported_type",
          `refusing put: body's leading bytes do not match any accepted file type for ${fileKey}`,
        );
      }
      if (sniffed !== pending.mimeType) {
        throw putError(
          "type_mismatch",
          `refusing put: body sniffs as ${sniffed}, which does not match the signed mimeType ${pending.mimeType} for ${fileKey}`,
        );
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    },

    async get(fileKey) {
      const target = pathFor(fileKey);
      try {
        return new Uint8Array(readFileSync(target));
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async exists(fileKey) {
      const target = pathFor(fileKey);
      try {
        statSync(target);
        return true;
      } catch (error) {
        if (isEnoent(error)) return false;
        throw error;
      }
    },

    async delete(fileKey) {
      const target = pathFor(fileKey);
      rmSync(target, { force: true });
    },

    verify(uploadUrl) {
      const match = UPLOAD_URL_PATTERN.exec(uploadUrl);
      if (!match) return { fileKey: "", valid: false, reason: "bad_signature" };
      const [, fileKey, exp, size, hash, sig] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const expected = sign(fileKey, Number(exp), Number(size), hash);
      const a = Buffer.from(sig, "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { fileKey, valid: false, reason: "bad_signature" };
      }
      if (now() > Number(exp)) return { fileKey, valid: false, reason: "expired" };
      return { fileKey, valid: true };
    },
  };
}
