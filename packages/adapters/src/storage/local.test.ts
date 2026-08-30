import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    const { fileKey } = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 3 });
    await s.put(fileKey, new Uint8Array([1, 2, 3]));
    expect(await s.get(fileKey)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null for a key that was never written", async () => {
    expect(await storage().get("nope")).toBeNull();
  });

  it("deletes", async () => {
    const s = storage();
    const { fileKey } = await s.signUpload({ contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1 });
    await s.put(fileKey, new Uint8Array([9]));
    await s.delete(fileKey);
    expect(await s.get(fileKey)).toBeNull();
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
      const outsideMarker = join(root, "..", `pf-outside-marker-${Date.now()}`);
      try {
        await s.put("../" + `pf-outside-marker-${Date.now()}`, new Uint8Array([1]));
      } catch {
        // expected: the adapter must refuse, not write outside root.
      }
      const { existsSync } = await import("node:fs");
      expect(existsSync(outsideMarker)).toBe(false);
    });
  });
});
