import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sniffMimeType } from "@pentefino/core";
import type { SignedDownload, SignedUpload, Storage } from "@pentefino/core/ports";

const TTL_MS = 5 * 60 * 1000;

// RF-242's export bundle puts signed download links inside a JSON file the
// person downloads and can keep or forward - unlike an upload URL (used once,
// immediately, by the browser that just requested it, never persisted
// anywhere), a download link's exposure window is however long that JSON
// file survives on whatever disk, inbox or chat it ends up in. 15 minutes is
// long enough to cover the export request/response round trip and a person
// opening the file shortly after downloading it, and short enough that a
// file forwarded or archived even an hour later carries dead links - while
// staying two orders of magnitude under the 30-day retention window the
// underlying object still has, so the link can never outlive what it points
// to by any meaningful margin.
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

// Content hashes are hex/base64url digests and owners are ids minted by
// newId() (nanoid's default alphabet), never arbitrary strings. Anything
// outside this set (path separators, "..", drive letters) is rejected before
// it can ever become part of a file key.
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

const UPLOAD_URL_PATTERN = /^local:\/\/(.+)\?exp=(\d+)&size=(\d+)&hash=([A-Za-z0-9_-]+)&sig=([0-9a-f]+)$/;
const DOWNLOAD_URL_PATTERN = /^local:\/\/(.+)\?exp=(\d+)&sig=([0-9a-f]+)$/;

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

  // Critical finding: naive colon-joining let a caller-controlled fileKey
  // that itself contained colons and digit groups make an upload message
  // and a download message collide on the exact same HMAC input - a
  // signature minted for one purpose then replayed as valid for the other
  // (`signDownload("somefile.pdf:9999999999999:1")` forging an upload sig
  // for fileKey "download:somefile.pdf"). Domain separation by a leading
  // literal prefix only worked as long as nothing else produced the same
  // bytes; it never actually made field boundaries unambiguous. Framing
  // each field as `<charLength>:<field>` does: decoding never guesses
  // where one field ends and the next begins, it reads the digits before
  // the next colon, consumes exactly that many characters, and moves on -
  // so a colon, a digit group, or any other byte *inside* a field can never
  // be misread as the boundary *between* fields, whatever the field
  // contains. Putting the purpose tag ("upload" / "download") in as the
  // first field, rather than as a bare string prefix, makes the two
  // domains differ before either message's content fields have even been
  // read, instead of resting on which literal prefix happens to come first.
  function framed(...fields: (string | number)[]): string {
    let out = "";
    for (const field of fields) {
      const s = String(field);
      out += `${s.length}:${s}`;
    }
    return out;
  }

  // Reframing this message (it used to be naive colon-joining, like
  // `signForDownload` below) changes what a previously-issued upload URL's
  // signature covers. That is safe to do here and only here: `put()`
  // refuses any fileKey with no live entry in the in-process
  // `pendingUploads` map, so an upload URL signed before a process restart
  // is already unusable regardless of what its signature says - there is no
  // "old signature, still valid, now mis-verified" case to worry about, and
  // nothing built on this format is deployed yet.
  function sign(fileKey: string, expiresAt: number, sizeBytes: number, contentHash: string): string {
    return createHmac("sha256", options.secret)
      .update(framed("upload", fileKey, expiresAt, sizeBytes, contentHash))
      .digest("hex");
  }

  // Domain-separated from `sign()` above by its own "download" purpose tag
  // as the first framed field - see `framed()`. `isSafeFileKey`, applied in
  // signDownload below, closes the actual hole the reviewer found (a
  // caller-controlled fileKey smuggling colons and digit groups); this
  // framing closes the same class of bug structurally, so a signature
  // minted for one purpose can never verify as the other even if some
  // future caller of `sign`/`signForDownload` skips that validation.
  function signForDownload(fileKey: string, expiresAt: number): string {
    return createHmac("sha256", options.secret).update(framed("download", fileKey, expiresAt)).digest("hex");
  }

  // The only fileKeys this storage ever mints are
  // `uploads/<owner>/<contentHash>.<ext>` - signUpload just below, and
  // apps/jobs/src/tasks/dossier.ts's store(), which only ever calls
  // signUpload and never builds a key by hand. signUpload already runs
  // SAFE_KEY_SEGMENT over owner and contentHash before it mints one;
  // signDownload has no such call in front of it - a caller hands it a
  // fileKey directly - so it has to hold that same line itself, before it
  // ever signs anything. Checked segment by segment, not as one regex over
  // the whole string, so nothing - a colon, a stray "/", any other
  // character - can smuggle itself into what looks like the owner, the
  // hash, or the extension.
  function isSafeFileKey(fileKey: string): boolean {
    const parts = fileKey.split("/");
    // `noUncheckedIndexedAccess` types every element of a non-tuple array as
    // `string | undefined`, so the length check above cannot narrow `parts[1]`
    // and `parts[2]` for TypeScript even though it guarantees them at
    // runtime - checked explicitly rather than asserted away.
    const [prefix, owner, nameAndExt] = parts;
    if (parts.length !== 3 || prefix !== "uploads" || owner === undefined || nameAndExt === undefined) {
      return false;
    }
    const dot = nameAndExt.lastIndexOf(".");
    if (dot <= 0) return false;
    const contentHash = nameAndExt.slice(0, dot);
    const extension = nameAndExt.slice(dot + 1);
    return SAFE_KEY_SEGMENT.test(owner) && SAFE_KEY_SEGMENT.test(contentHash) && SAFE_KEY_SEGMENT.test(extension);
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

    async signDownload(fileKey): Promise<SignedDownload> {
      // Critical finding: this used to accept any string that merely didn't
      // escape the storage root, which is a much looser bar than the shape
      // this storage actually mints - and a caller-supplied fileKey outside
      // that shape (embedded colons, extra segments) is exactly what let a
      // download signature be replayed as an upload signature for an
      // attacker-chosen key, size and hash (see the comment on `sign`
      // above). Refusing anything that is not `uploads/<owner>/<hash>.<ext>`
      // closes that off at the source, before framing even comes into it.
      if (!isSafeFileKey(fileKey)) {
        throw new Error(`refusing unsafe fileKey: ${fileKey}`);
      }
      // Resolved through pathFor purely to refuse a key that escapes the
      // storage root before it can ever be signed - same discipline as
      // signUpload, even though a download never touches the filesystem
      // here. Existence is deliberately not checked: that is the caller's
      // question (RF-242's export handler checks it first, so an
      // already-deleted file gets an honest "deleted on" marker instead of
      // a dead link), not this method's.
      pathFor(fileKey);
      const expiresAt = now() + DOWNLOAD_TTL_MS;
      const sig = signForDownload(fileKey, expiresAt);
      return {
        url: `local://${fileKey}?exp=${expiresAt}&sig=${sig}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    verifyDownload(url) {
      const match = DOWNLOAD_URL_PATTERN.exec(url);
      if (!match) return { fileKey: "", valid: false, reason: "bad_signature" };
      const [, fileKey, exp, sig] = match as unknown as [string, string, string, string];
      const expected = signForDownload(fileKey, Number(exp));
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
