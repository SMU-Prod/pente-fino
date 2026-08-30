import { z } from "zod";
import { newId } from "@pentefino/core";
import { ensureAnonymousSession, withUser } from "@pentefino/db";
import { cookies } from "next/headers";
import { apiError } from "@/lib/errors.js";
import {
  SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, getSessionSecret, readSession, signSession,
} from "@/lib/session.js";
import { container } from "@/lib/container.js";

const MAX_BYTES = 15 * 1024 * 1024;

// RF-104 requires validating the *actual* file type by magic bytes, never by
// a client-declared MIME type or a filename extension. This route runs
// before any bytes exist - it only signs an upload URL from metadata the
// client asserts about a file it has not sent yet - so the check below is a
// best-effort, spoofable early rejection for UX only (fail fast on an
// obviously wrong declared type). The authoritative magic-byte check has to
// run once real bytes are available: either inside the storage adapter's
// `put()` (`packages/adapters/src/storage/local.ts`, Task 11) before it
// writes the object, or as a first step of the ingest task
// (`apps/jobs/src/tasks/ingest.ts`, Task 13) before the AI provider ever
// sees the file. Neither does that today - RF-104 is not fully closed until
// one of them does.
const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/heic"];

const Body = z.object({
  contentHash: z.string().min(16),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
});

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    // Malformed JSON never reaches Body.safeParse - it throws inside
    // request.json() itself. Caught here so every rejection this route can
    // produce keeps the { error: { code, message } } shape (PRD §8.1)
    // instead of an unhandled exception turning into a bare framework 500.
    return apiError("unsupported_type");
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) return apiError("unsupported_type");

  const { contentHash, mimeType, sizeBytes } = parsed.data;
  if (sizeBytes > MAX_BYTES) return apiError("file_too_large");
  if (!ACCEPTED.includes(mimeType)) return apiError("unsupported_type");

  const secret = getSessionSecret();
  const jar = await cookies();
  const existing = jar.get(SESSION_COOKIE)?.value;
  const validExistingSessionId = existing ? readSession(existing, secret) : null;
  const sessionId = validExistingSessionId ?? newId("ses");

  const { db, storage } = container();

  // `invoices.session_id` carries a real foreign key to
  // `anonymous_sessions.id`: a brand-new session id needs that row created
  // before the insertInvoice below can succeed. A session the cookie already
  // proved was ours does not need this again - the row was created the
  // first time this branch ran for it.
  if (!validExistingSessionId) {
    await ensureAnonymousSession(sessionId, new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000), db);
  }

  const scoped = withUser({ sessionId }, db);

  // RF-102: signing the same content hash twice for the same owner returns
  // the existing invoice instead of creating a second one. This route never
  // enqueues extraction itself (that only happens via
  // /api/invoices/[id]/process), so "does not trigger a second extraction"
  // holds trivially for a repeat sign - the guard below only decides whether
  // a second invoice row and a second invoice_uploaded event are created.
  const already = (await scoped.invoices()).find((row) => row.contentHash === contentHash);
  const signed = await storage.signUpload({ contentHash, mimeType, sizeBytes });
  const invoiceId = already?.id ?? await scoped.insertInvoice({
    contentHash,
    source: mimeType === "application/pdf" ? "pdf_text" : "photo",
    fileKey: signed.fileKey,
  });

  if (!already) await scoped.recordEvent("invoice_uploaded", { source: mimeType });

  const response = Response.json({ uploadUrl: signed.uploadUrl, fileKey: signed.fileKey, invoiceId });
  if (!validExistingSessionId) {
    jar.set(SESSION_COOKIE, signSession(sessionId, secret), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
  }
  return response;
}
