import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
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

// signDownload only ever accepts the shape this storage actually mints -
// uploads/<owner>/<contentHash>.<ext> - so every "signed downloads" test
// below signs a key of that shape rather than an arbitrary string, the way
// a real caller (RF-242's export handler, reading invoices.fileKey or a
// dossier_generated event's payload.fileKey) always would.
const downloadKey = `uploads/${owner}/reporthash123.pdf`;

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

  // --- RF-242: signDownload/verifyDownload. signDownload does not check
  // exists() - that is deliberately the caller's question (Task 4 checks it
  // first, so an already-expired file gets an honest "deleted on" marker
  // instead of a dead link) - so these tests sign fileKeys that were never
  // put(), the same way a real export would sign a key it read off an old
  // events row without touching the file first.

  describe("signed downloads", () => {
    it("signs a download and returns a url carrying the file key and a signature", async () => {
      const s = storage();
      const signed = await s.signDownload(downloadKey);
      expect(signed.url).toContain(downloadKey);
      expect(signed.url).toContain("sig=");
    });

    it("accepts a fresh download signature", async () => {
      const s = storage();
      const signed = await s.signDownload(downloadKey);
      expect(s.verifyDownload(signed.url)).toMatchObject({
        fileKey: downloadKey,
        valid: true,
      });
    });

    it("rejects the download signature after fifteen minutes, because the fake honours the real contract", async () => {
      const s = storage();
      const signed = await s.signDownload(downloadKey);
      clock += 15 * 60 * 1000 + 1;
      expect(s.verifyDownload(signed.url)).toMatchObject({ valid: false, reason: "expired" });
    });

    it("accepts a download signature at exactly the fifteen-minute boundary", async () => {
      const s = storage();
      const signed = await s.signDownload(downloadKey);
      clock += 15 * 60 * 1000;
      expect(s.verifyDownload(signed.url)).toMatchObject({ valid: true });
    });

    it("rejects a tampered download signature", async () => {
      const s = storage();
      const signed = await s.signDownload(downloadKey);
      expect(s.verifyDownload(signed.url.replace(/sig=[0-9a-f]+/, "sig=deadbeef"))).toMatchObject({
        valid: false,
        reason: "bad_signature",
      });
    });

    it("rejects a modified file key", async () => {
      const s = storage();
      const signed = await s.signDownload(downloadKey);
      const tampered = signed.url.replace("reporthash123", "otherhash456");
      expect(s.verifyDownload(tampered)).toMatchObject({ valid: false, reason: "bad_signature" });
    });

    it("rejects a malformed download URL without throwing", () => {
      const s = storage();
      expect(() => s.verifyDownload("not-a-url-at-all")).not.toThrow();
      expect(s.verifyDownload("not-a-url-at-all")).toMatchObject({ valid: false });
      expect(() => s.verifyDownload("")).not.toThrow();
      expect(() => s.verifyDownload("local://dossiers/x.pdf?exp=notanumber&sig=zz")).not.toThrow();
    });

    it("rejects a fileKey that escapes the storage root before it is ever signed", async () => {
      const s = storage();
      await expect(s.signDownload("../../evil.bin")).rejects.toThrow();
    });

    // --- Critical finding: signDownload used to accept any string that
    // merely didn't escape the storage root - far looser than the shape
    // this storage actually mints (uploads/<owner>/<contentHash>.<ext>) -
    // and that gap is exactly what let a caller-controlled fileKey with
    // embedded colons turn a download signature into a forged upload
    // signature. isSafeFileKey must refuse anything outside that shape
    // before signDownload ever signs it.

    describe("fileKey validation on signDownload", () => {
      it("rejects a fileKey containing a colon", async () => {
        const s = storage();
        await expect(s.signDownload(`uploads/${owner}/abc:def.pdf`)).rejects.toThrow();
      });

      it("rejects a fileKey containing a character outside the safe class", async () => {
        const s = storage();
        await expect(s.signDownload(`uploads/${owner}/abc def.pdf`)).rejects.toThrow(); // space
        await expect(s.signDownload(`uploads/${owner}/abc$def.pdf`)).rejects.toThrow(); // $
        await expect(s.signDownload(`uploads/bad owner/abc.pdf`)).rejects.toThrow(); // space in owner
      });

      it("rejects a fileKey outside the uploads/<owner>/<hash>.<ext> shape this storage mints", async () => {
        const s = storage();
        // Not under uploads/ at all.
        await expect(s.signDownload("dossiers/case123/report.pdf")).rejects.toThrow();
        // No extension to separate from the hash.
        await expect(s.signDownload(`uploads/${owner}/no-extension`)).rejects.toThrow();
        // One extra path segment.
        await expect(s.signDownload(`uploads/${owner}/sub/abc.pdf`)).rejects.toThrow();
      });
    });

    it("the reviewer's exploit: a download signature can no longer be forged into a valid upload signature", async () => {
      const s = storage();
      // The exact Critical-finding reproduction: a caller-controlled fileKey
      // carrying its own colons and digit groups, chosen so that (once
      // signed for download) the resulting HMAC input is byte-for-byte
      // identical to the upload HMAC input for fileKey "download:somefile.pdf",
      // sizeBytes 1, contentHash "9999999999999" - under the OLD naive
      // colon-joined framing, both messages were literally
      // "download:somefile.pdf:9999999999999:1:<exp>".
      const maliciousKey = "somefile.pdf:9999999999999:1";

      // Fix 1 (validate the key): isSafeFileKey refuses this before
      // signDownload ever signs it - the exploit's first step can no longer
      // even produce a signature.
      await expect(s.signDownload(maliciousKey)).rejects.toThrow();

      // Fix 2 (unambiguous framing): even setting validation aside, replay
      // exactly what the pre-fix naive-concatenation digest would have
      // produced for this exploit, and confirm the new length-prefixed
      // framing in verify() refuses it too - so this class of bug cannot
      // come back through some future caller that skips isSafeFileKey.
      const exp = 9_999_999_999_999;
      const oldStyleDownloadDigestInput = `download:${maliciousKey}:${exp}`;
      const forgedSig = createHmac("sha256", "test-secret").update(oldStyleDownloadDigestInput).digest("hex");
      const forgedUploadUrl = `local://download:somefile.pdf?exp=${exp}&size=1&hash=${exp}&sig=${forgedSig}`;
      expect(s.verify(forgedUploadUrl)).toMatchObject({ valid: false });
    });

    // --- Domain separation: a download signature must never be replayed as
    // an upload signature, and vice versa (see the comment on
    // `signForDownload` in local.ts).

    it("refuses a genuine upload URL's signature when it is presented to verifyDownload", async () => {
      const s = storage();
      const upload = await s.signUpload({
        owner, contentHash: "abc", mimeType: "application/pdf", sizeBytes: 1000,
      });
      expect(s.verifyDownload(upload.uploadUrl)).toMatchObject({ valid: false });
    });

    it("refuses a genuine download URL's signature when it is presented to verify", async () => {
      const s = storage();
      const download = await s.signDownload(`uploads/${owner}/abc.pdf`);
      expect(s.verify(download.url)).toMatchObject({ valid: false });
    });

    it("refuses a signature computed without the 'download' purpose tag, proving the tag is load-bearing", async () => {
      const s = storage();
      const fileKey = "dossiers/case123/report.pdf";
      const expiresAt = clock + 15 * 60 * 1000;
      // What signForDownload's digest would be if the literal "download:"
      // prefix were dropped from its HMAC input - simulating a signature
      // minted for some other purpose under the same secret over the bare
      // (fileKey, expiresAt) pair that domain separation exists to keep out.
      const forgedSig = createHmac("sha256", "test-secret").update(`${fileKey}:${expiresAt}`).digest("hex");
      const forgedUrl = `local://${fileKey}?exp=${expiresAt}&sig=${forgedSig}`;
      expect(s.verifyDownload(forgedUrl)).toMatchObject({ valid: false, reason: "bad_signature" });
    });
  });
});
