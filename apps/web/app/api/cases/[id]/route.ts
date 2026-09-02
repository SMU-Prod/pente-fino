import { cookies } from "next/headers";
import { resolveSession, withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

/**
 * PRD §8.2, `GET /api/cases/:id` - everything one case's screen reads, in
 * the four keys §8.2 names: `{ case, documents, protocols, timeline }`.
 *
 * **INV-008.** The read path is where a leak would matter most: this is the
 * route a shared link, a bookmark, or plain id-guessing tries first. Same
 * split as `/api/invoices/[id]/report` and the document-edit route -
 * `forbidden` means "no valid session was presented at all", `not_found`
 * means "identity known, but this is not yours". `caseDetail` proves
 * ownership on the case itself and returns the same `null` for a case
 * belonging to somebody else as for one that never existed, so nothing here
 * can tell the two apart. `resolveSession` first, because a session RF-147
 * has claimed must scope on its `userId`; an unclaimed one resolves to a
 * bare `{ sessionId }`, and `cases.userId` being NOT NULL means it owns no
 * case and gets the same `not_found`.
 *
 * **`timeline` is the case's own `events` rows in chronological order.**
 * This is what makes principle A3 worth having: every state transition
 * wrote a row, so the history can be read back from `events` alone rather
 * than inferred from whatever the `cases` row currently says. E5 Task 7's
 * dossier reads the same history through the same method.
 *
 * **INV-007.** Everything returned here is user-facing, and it now carries
 * free text the person typed - a close note - alongside generated
 * documents. The note is masked at write time, inside `closeCase`, before
 * it ever reaches `events.payload`; this route does not re-mask, because
 * masking a value that is already stored masked would only hide whether the
 * write path is still doing its job.
 *
 * **This route records no event, deliberately.** RF-185 wants reminders
 * suppressed when the person opened the case in the last 24 hours, which
 * needs a recorded "opened" fact to read - but `packages/core/src/events.ts`
 * has no such type in its catalogue, and event names are a contract there
 * ("adding is free, renaming requires migrating dashboards"). Inventing one
 * here would put a name into the trail that no dashboard, metric or job
 * agreed to; E5 Task 6 owns that decision, and RF-185 stays unserved until
 * it makes it.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  const { db } = container();
  const session = await resolveSession(sessionId, db);
  const scoped = withUser(session, db);

  const detail = await scoped.caseDetail(id);
  if (!detail) return apiError("not_found");

  return Response.json(detail);
}
