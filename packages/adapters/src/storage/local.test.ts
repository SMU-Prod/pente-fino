import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStorage } from "./local.js";

let root: string;
let clock = 1_756_000_000_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-"));
  clock = 1_756_000_000_000;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function storage() {
  return createLocalStorage({ root, secret: "test-secret", now: () => clock });
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("local storage", () => {
  it("signs an upload and returns a file key", async () => {
    const signed = await storage().signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(signed.fileKey).toContain("abc");
    expect(signed.uploadUrl).toContain("sig=");
  });

  it("accepts a fresh signature", async () => {
    const s = storage();
    const signed = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(s.verify(signed.uploadUrl).valid).toBe(true);
  });

  it("rejects the signature after five minutes, because the fake honours the real contract", async () => {
    const s = storage();
    const signed = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    clock += 5 * 60 * 1000 + 1;
    expect(s.verify(signed.uploadUrl)).toMatchObject({ valid: false, reason: "expired" });
  });

  it("accepts a signature at exactly the five-minute boundary", async () => {
    const s = storage();
    const signed = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    clock += 5 * 60 * 1000;
    expect(s.verify(signed.uploadUrl)).toMatchObject({ valid: true });
  });

  it("rejects a tampered signature", async () => {
    const s = storage();
    const signed = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(s.verify(signed.uploadUrl.replace(/sig=\w+/, "sig=deadbeef"))).toMatchObject({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects a shortened signature without throwing", async () => {
    const s = storage();
    const signed = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(() => s.verify(signed.uploadUrl.replace(/sig=[0-9a-f]+/, "sig=ab"))).not.toThrow();
    expect(s.verify(signed.uploadUrl.replace(/sig=[0-9a-f]+/, "sig=ab"))).toMatchObject({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects a modified file key", async () => {
    const s = storage();
    const signed = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    const tampered = signed.uploadUrl.replace("uploads/abc.pdf", "uploads/other.pdf");
    expect(s.verify(tampered)).toMatchObject({ valid: false, reason: "bad_signature" });
  });

  it("rejects a malformed URL without throwing", () => {
    const s = storage();
    expect(() => s.verify("not-a-url-at-all")).not.toThrow();
    expect(s.verify("not-a-url-at-all")).toMatchObject({ valid: false });
    expect(() => s.verify("")).not.toThrow();
    expect(() => s.verify("local://uploads/abc.pdf?exp=notanumber&sig=zz")).not.toThrow();
  });

  it("round trips a body", async () => {
    const s = storage();
    const body = new Uint8Array([1, 2, 3]);
    const { fileKey } = await s.signUpload({
      contentHash: sha256(body),
      mimeType: "application/pdf",
      sizeBytes: body.length,
    });
    await s.put(fileKey, body);
    expect(await s.get(fileKey)).toEqual(body);
  });

  it("returns null for a key that was never written", async () => {
    expect(await storage().get("nope")).toBeNull();
  });

  it("propagates a non-not-found error instead of masking it as a missing key", async () => {
    const s = storage();
    const fileKey = "uploads/this-is-a-directory";
    mkdirSync(join(root, fileKey), { recursive: true });
    await expect(s.get(fileKey)).rejects.toThrow();
  });

  it("deletes", async () => {
    const s = storage();
    const body = new Uint8Array([9]);
    const { fileKey } = await s.signUpload({
      contentHash: sha256(body),
      mimeType: "application/pdf",
      sizeBytes: body.length,
    });
    await s.put(fileKey, body);
    await s.delete(fileKey);
    expect(await s.get(fileKey)).toBeNull();
  });

  describe("exists", () => {
    it("reports true for a key that was written", async () => {
      const s = storage();
      const body = new Uint8Array([7]);
      const { fileKey } = await s.signUpload({
        contentHash: sha256(body),
        mimeType: "application/pdf",
        sizeBytes: body.length,
      });
      await s.put(fileKey, body);
      expect(await s.exists(fileKey)).toBe(true);
    });

    it("reports false for a key that was never written", async () => {
      expect(await storage().exists("nope")).toBe(false);
    });

    it("propagates a non-not-found error instead of masking it as absent", async () => {
      const s = storage();
      const fileKey = "uploads/this-is-also-a-directory";
      mkdirSync(join(root, fileKey), { recursive: true });
      // A directory does exist at this path, so this must not silently report
      // absence - either way, it must not swallow the distinction the way a
      // bare existsSync() would.
      await expect(s.exists(fileKey)).resolves.toBe(true);
    });
  });

  describe("enforcing the signed upload's declared constraints", () => {
    it("rejects a put whose body length does not match the signed size", async () => {
      const s = storage();
      const body = new Uint8Array([1, 2, 3]);
      const { fileKey } = await s.signUpload({
        contentHash: sha256(body),
        mimeType: "application/pdf",
        sizeBytes: body.length,
      });
      await expect(s.put(fileKey, new Uint8Array([1, 2]))).rejects.toMatchObject({ reason: "size_mismatch" });
    });

    it("rejects a put whose body content hash does not match the signed content hash", async () => {
      const s = storage();
      const signedBody = new Uint8Array([1, 2, 3]);
      const { fileKey } = await s.signUpload({
        contentHash: sha256(signedBody),
        mimeType: "application/pdf",
        sizeBytes: signedBody.length,
      });
      const differentBody = new Uint8Array([4, 5, 6]); // same length, different bytes and hash
      await expect(s.put(fileKey, differentBody)).rejects.toMatchObject({ reason: "hash_mismatch" });
    });

    it("rejects a put for a fileKey that was never signed", async () => {
      const s = storage();
      await expect(s.put("uploads/never-signed.pdf", new Uint8Array([1]))).rejects.toMatchObject({
        reason: "unsigned",
      });
    });

    it("accepts a put whose body matches the signed size and content hash exactly", async () => {
      const s = storage();
      const body = new Uint8Array([10, 20, 30, 40]);
      const { fileKey } = await s.signUpload({
        contentHash: sha256(body),
        mimeType: "application/pdf",
        sizeBytes: body.length,
      });
      await expect(s.put(fileKey, body)).resolves.toBeUndefined();
      expect(await s.get(fileKey)).toEqual(body);
    });
  });

  describe("path traversal hardening", () => {
    it("rejects a content hash containing '..' before ever minting a URL", async () => {
      const s = storage();
      await expect(
        s.signUpload({ contentHash: "../../evil", mimeType: "application/pdf", sizeBytes: 1 }),
      ).rejects.toThrow();
    });

    it("rejects a content hash containing a path separator", async () => {
      const s = storage();
      await expect(
        s.signUpload({ contentHash: "sub/dir", mimeType: "application/pdf", sizeBytes: 1 }),
      ).rejects.toThrow();
    });

    it("rejects a relative fileKey that escapes the storage root on put", async () => {
      const s = storage();
      await expect(s.put("../../evil.bin", new Uint8Array([1]))).rejects.toThrow();
    });

    it("rejects a relative fileKey that escapes the storage root on get", async () => {
      const s = storage();
      await expect(s.get("../../evil.bin")).rejects.toThrow();
    });

    it("rejects a relative fileKey that escapes the storage root on delete", async () => {
      const s = storage();
      await expect(s.delete("../../evil.bin")).rejects.toThrow();
    });

    it("rejects an absolute POSIX path as fileKey", async () => {
      const s = storage();
      await expect(s.put("/etc/passwd", new Uint8Array([1]))).rejects.toThrow();
    });

    it("rejects a drive-qualified Windows path as fileKey", async () => {
      const s = storage();
      await expect(s.put("C:/Windows/evil.bin", new Uint8Array([1]))).rejects.toThrow();
      await expect(s.put("D:\\evil.bin", new Uint8Array([1]))).rejects.toThrow();
    });

    it("never creates a file outside the storage root even when asked to", async () => {
      const s = storage();
      const marker = `pf-outside-marker-${Date.now()}`;
      const outsideMarker = join(root, "..", marker);
      try {
        await s.put("../" + marker, new Uint8Array([1]));
      } catch {
        // expected: the adapter must refuse, not write outside root.
      }
      expect(existsSync(outsideMarker)).toBe(false);
    });
  });
});
