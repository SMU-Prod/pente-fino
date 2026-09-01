import { cookies } from "next/headers";
import { z } from "zod";
import { requestClaimCode } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { CLAIM_CODE_EMAIL_SUBJECT, getClaimCodeSecret, renderClaimCodeEmail } from "@/lib/claim.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

const Body = z.object({ email: z.string().min(3).max(254) });

/**
 * PRD §8.2/RF-147, first half: sends the e-mail code that, once confirmed
 * (the companion route at ./confirm/route.ts), migrates this anonymous
 * session's invoices to a user. Requires a valid anonymous session cookie -
 * with none, there is nothing for this call to claim, so it comes back
 * `forbidden` the same way every other route with a session-scoped body
 * does (see apps/web/app/api/invoices/[id]/report/route.ts).
 *
 * §8.3's 3-per-hour-per-e-mail limit is enforced by `requestClaimCode`
 * itself (packages/db/src/claim.ts) - see that file's header comment for
 * why it is keyed by e-mail rather than by this session or by IP, and why a
 * genuine retry (someone who never received the first mail) draws from the
 * exact same budget as anyone else touching that address.
 */
export async function POST(request: Request) {
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    // Same idiom as /api/findings/[id]/feedback: PRD §8.1 has no dedicated
    // validation-failure code, so a malformed body is reported the same
    // generic way as any other "there is nothing here for you" case.
    return apiError("not_found");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return apiError("not_found");
  const { email } = parsed.data;

  // The mailer rejects a `to` carrying a raw CR or LF (header injection -
  // see packages/adapters/src/mailer/local.ts) - checked here too so a
  // malformed address is reported the same way as any other malformed body
  // instead of bubbling up as an uncaught mailer error and a bare 500.
  if (/[\r\n]/.test(email)) return apiError("not_found");

  const { db, mailer } = container();
  const codeSecret = getClaimCodeSecret();
  const result = await requestClaimCode({ email, sessionId, secret: codeSecret }, db);

  if (!result.ok) {
    const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
    return apiError("rate_limited", undefined, { "Retry-After": String(retryAfterSeconds) });
  }

  await mailer.send({
    to: email,
    subject: CLAIM_CODE_EMAIL_SUBJECT,
    body: renderClaimCodeEmail(result.code),
  });

  return Response.json({ ok: true });
}
