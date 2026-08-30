import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SignedUpload, Storage } from "@pentefino/core/ports";

const TTL_MS = 5 * 60 * 1000;

// Content hashes are hex/base64url digests, never arbitrary strings. Anything
// outside this set (path separators, "..", drive letters) is rejected before
// it can ever become part of a file key.
const SAFE_CONTENT_HASH = /^[A-Za-z0-9_-]+$/;

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

  function sign(fileKey: string, expiresAt: number): string {
    return createHmac("sha256", options.secret).update(`${fileKey}:${expiresAt}`).digest("hex");
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
    async signUpload({ contentHash, mimeType }): Promise<SignedUpload> {
      if (!SAFE_CONTENT_HASH.test(contentHash)) {
        throw new Error(`refusing unsafe contentHash: ${contentHash}`);
      }
      const extension = mimeType === "application/pdf" ? "pdf" : "bin";
      const fileKey = `uploads/${contentHash}.${extension}`;
      const expiresAt = now() + TTL_MS;
      const sig = sign(fileKey, expiresAt);
      return {
        fileKey,
        uploadUrl: `local://${fileKey}?exp=${expiresAt}&sig=${sig}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async put(fileKey, body) {
      const target = pathFor(fileKey);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    },

    async get(fileKey) {
      const target = pathFor(fileKey);
      try {
        return new Uint8Array(readFileSync(target));
      } catch {
        return null;
      }
    },

    async delete(fileKey) {
      const target = pathFor(fileKey);
      rmSync(target, { force: true });
    },

    verify(uploadUrl) {
      const match = /^local:\/\/(.+)\?exp=(\d+)&sig=([0-9a-f]+)$/.exec(uploadUrl);
      if (!match) return { fileKey: "", valid: false, reason: "bad_signature" };
      const [, fileKey, exp, sig] = match as unknown as [string, string, string, string];
      const expected = sign(fileKey, Number(exp));
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
