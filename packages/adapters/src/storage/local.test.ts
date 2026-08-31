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

// A real PDF magic-byte header, so bodies passed to put() sniff as
// "application/pdf" - the same as every mimeType these tests declare at
// signUpload(). Task 4 makes put() sniff the real bytes rather than trust
// the declared mimeType, so a fixture body of arbitrary bytes ([1, 2, 3])
// no longer round trips: it would now be refused as unsupported_type.
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46];
function pdfBody(...trailing: number[]): Uint8Array {
  return new Uint8Array([...PDF_HEADER, ...trailing]);
}

const owner = "ses_owner00000000000000";

describe("local storage", () => {
  it("signs an upload and returns a file key", async () => {
    const signed = await storage().signUpload({
      owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000,
    });
    expect(signed.fileKey).toContain("abc");
    expect(signed.uploadUrl).toContain("sig=");
  });

  // --- Finding 1: two owners must never share one object. RF-102's dedup
  // index is `(coalesce(user_id, session_id), content_hash)` - per owner -
  // but the key minted here used to drop the owner entirely, so two tenants
  // uploading a file with the same hash collided on one storage object: an
  // RF-110 cleanup deleting one owner's expired invoice would delete the
  // other's file too, and a caller who merely knew a hash (never uploaded
  // anything) could sign for it and have ingest extract someone else's file
  // into their own report.

  it("scopes the file key to the owner, so two owners with the same content hash do not collide", async () => {
    const s = storage();
    const a = await s.signUpload({
      owner: "ses_ownerA000000000000", contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000,
    });
    const b = await s.signUpload({
      owner: "ses_ownerB000000000000", contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000,
    });
    expect(a.fileKey).not.toBe(b.fileKey);
    expect(a.fileKey).toContain("ses_ownerA000000000000");
    expect(b.fileKey).toContain("ses_ownerB000000000000");
  });

  it("does not let owner B's put land on owner A's file key for the same content hash", async () => {
    const s = storage();
    const bodyA = pdfBody(1, 2, 3);
    const bodyB = pdfBody(1, 2, 3); // same bytes - same hash - different owner
    const a = await s.signUpload({
      owner: "ses_ownerA000000000000", contentHash: sha256(bodyA), mimeType: "application/pdf", sizeBytes: bodyA.length,
    });
    const b = await s.signUpload({
      owner: "ses_ownerB000000000000", contentHash: sha256(bodyB), mimeType: "application/pdf", sizeBytes: bodyB.length,
    });
    await s.put(a.fileKey, bodyA);
    await expect(s.exists(b.fileKey)).resolves.toBe(false);
    await s.delete(a.fileKey);
    // Deleting owner A's object must never remove owner B's - the whole
    // point of scoping the key is that RF-110's cleanup for one owner can
    // never touch another owner's file (finding 1).
    await s.put(b.fileKey, bodyB);
    await expect(s.exists(b.fileKey)).resolves.toBe(true);
  });

  it("rejects an owner containing a path separator, before ever minting a URL", async () => {
    const s = storage();
    await expect(
      s.signUpload({ owner: "../evil", contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1 }),
    ).rejects.toThrow();
  });

  it("accepts a fresh signature", async () => {
    const s = storage();
    const signed = await s.signUpload({ owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(s.verify(signed.uploadUrl).valid).toBe(true);
  });

  it("rejects the signature after five minutes, because the fake honours the real contract", async () => {
    const s = storage();
    const signed = await s.signUpload({ owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    clock += 5 * 60 * 1000 + 1;
    expect(s.verify(signed.uploadUrl)).toMatchObject({ valid: false, reason: "expired" });
  });

  it("accepts a signature at exactly the five-minute boundary", async () => {
    const s = storage();
    const signed = await s.signUpload({ owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    clock += 5 * 60 * 1000;
    expect(s.verify(signed.uploadUrl)).toMatchObject({ valid: true });
  });

  it("rejects a tampered signature", async () => {
    const s = storage();
    const signed = await s.signUpload({ owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(s.verify(signed.uploadUrl.replace(/sig=\w+/, "sig=deadbeef"))).toMatchObject({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects a shortened signature without throwing", async () => {
    const s = storage();
    const signed = await s.signUpload({ owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(() => s.verify(signed.uploadUrl.replace(/sig=[0-9a-f]+/, "sig=ab"))).not.toThrow();
    expect(s.verify(signed.uploadUrl.replace(/sig=[0-9a-f]+/, "sig=ab"))).toMatchObject({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects a modified file key", async () => {
    const s = storage();
    const signed = await s.signUpload({ owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000 });
    const tampered = signed.uploadUrl.replace(`uploads/${owner}/abc.pdf`, `uploads/${owner}/other.pdf`);
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
    const body = pdfBody(1, 2, 3);
    const { fileKey } = await s.signUpload({
      owner,
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
    const body = pdfBody(9);
    const { fileKey } = await s.signUpload({
      owner,
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
      const body = pdfBody(7);
      const { fileKey } = await s.signUpload({
        owner,
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
        owner,
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
        owner,
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
      const body = pdfBody(10, 20, 30, 40);
      const { fileKey } = await s.signUpload({
        owner,
        contentHash: sha256(body),
        mimeType: "application/pdf",
        sizeBytes: body.length,
      });
      await expect(s.put(fileKey, body)).resolves.toBeUndefined();
      expect(await s.get(fileKey)).toEqual(body);
    });

    // --- RF-104: the sign route only ever sees a client-declared mimeType on
    // a file it has not received yet, so it cannot enforce the real type
    // (see the note on ACCEPTED in apps/web/app/api/uploads/sign/route.ts).
    // put() is where real bytes exist, so it is where the check has to land.

    it("rejects a put whose bytes do not sniff as any accepted type", async () => {
      const s = storage();
      const body = new Uint8Array([1, 2, 3, 4]); // no magic bytes at all
      const { fileKey } = await s.signUpload({
        owner, contentHash: sha256(body), mimeType: "application/pdf", sizeBytes: body.length,
      });
      await expect(s.put(fileKey, body)).rejects.toMatchObject({ reason: "unsupported_type" });
    });

    it("rejects a .docx renamed to .pdf - a ZIP header sniffs as nothing accepted", async () => {
      const s = storage();
      // PK\x03\x04: every .docx (and every ZIP) starts with this, whatever
      // the filename or declared mimeType claims.
      const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
      const { fileKey } = await s.signUpload({
        owner, contentHash: sha256(body), mimeType: "application/pdf", sizeBytes: body.length,
      });
      await expect(s.put(fileKey, body)).rejects.toMatchObject({ reason: "unsupported_type" });
    });

    it("rejects a put whose sniffed type contradicts the mimeType signUpload was called with", async () => {
      const s = storage();
      // A real PNG header, signed as if it were a PDF.
      const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
      const { fileKey } = await s.signUpload({
        owner, contentHash: sha256(body), mimeType: "application/pdf", sizeBytes: body.length,
      });
      await expect(s.put(fileKey, body)).rejects.toMatchObject({ reason: "type_mismatch" });
    });

    it("does not write the object to disk when the type check rejects it", async () => {
      const s = storage();
      const body = new Uint8Array([1, 2, 3, 4]);
      const { fileKey } = await s.signUpload({
        owner, contentHash: sha256(body), mimeType: "application/pdf", sizeBytes: body.length,
      });
      await expect(s.put(fileKey, body)).rejects.toThrow();
      expect(await s.exists(fileKey)).toBe(false);
    });
  });

  describe("path traversal hardening", () => {
    it("rejects a content hash containing '..' before ever minting a URL", async () => {
      const s = storage();
      await expect(
        s.signUpload({ owner, contentHash: "../../evil", mimeType: "application/pdf", sizeBytes: 1 }),
      ).rejects.toThrow();
    });

    it("rejects a content hash containing a path separator", async () => {
      const s = storage();
      await expect(
        s.signUpload({ owner, contentHash: "sub/dir", mimeType: "application/pdf", sizeBytes: 1 }),
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
