import { cookies } from "next/headers";
import { z } from "zod";
import { confirmClaimCode } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { getClaimCodeSecret } from "@/lib/claim.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

const Body = z.object({
  email: z.string().min(3).max(254),
  code: z.string().regex(/^\d{6}$/),
});

/**
 * PRD §8.2/RF-147, second half. INV-008: the lookup inside
 * `confirmClaimCode` is scoped by *this* session id, not just the e-mail,
 * so a code minted for a different anonymous session can never be redeemed
 * here (see that function's doc comment in packages/db/src/claim.ts) - the
 * migration this unlocks must not become a way to reach another session's
 * rows.
 *
 * A wrong code, an expired code, an exhausted code, and a code that was
 * never requested for this exact (email, session) pair all collapse into
 * the same `not_found` response, for the same reason
 * `/api/findings/[id]/feedback` collapses "not yours" with "does not
 * exist": nothing here should let a caller learn which of those it was.
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
    return apiError("not_found");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return apiError("not_found");
  const { email, code } = parsed.data;

  const { db } = container();
  const codeSecret = getClaimCodeSecret();
  const result = await confirmClaimCode({ email, code, sessionId, secret: codeSecret }, db);
  if (!result.ok) return apiError("not_found");

  return Response.json({ ok: true });
}
