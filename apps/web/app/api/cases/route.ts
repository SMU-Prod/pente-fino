import { cookies } from "next/headers";
import { z } from "zod";
import { resolveSession, withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

// PRD §8.2's body, verbatim. The cap on `findingIds` is not a guess at a
// product limit: it bounds the `IN` list a single unauthenticated-shaped
// request can make `createCase` build, and a real contestation names the
// handful of charges a person actually disputes, not hundreds. Nothing
// downstream would reject a longer list, so the bound has to live here.
const MAX_FINDING_IDS = 200;

const Body = z.object({
  invoiceId: z.string().min(1),
  findingIds: z.array(z.string().min(1)).min(1).max(MAX_FINDING_IDS),
});

/**
 * PRD §8.2, `POST /api/cases`. This is the route that fills E5's
 * case-creation hole: until it existed nothing in the product could turn a
 * report's findings into a dispute at all.
 *
 * **INV-008.** `resolveSession` turns this request's raw `sessionId` cookie
 * into whichever `Session` `withUser` should scope on: a session RF-147 has
 * claimed resolves to that `userId`, and every other session - never
 * claimed, or claimed under a different account - resolves to a bare
 * `{ sessionId }`. `cases.userId` is NOT NULL (`packages/db/src/with-user.ts`),
 * so a bare session can never own a case; `createCase` returns `null` for
 * it rather than attempting an insert that the column would reject. That is
 * why an unclaimed-but-valid session gets `not_found` and never a 500 -
 * `forbidden` here is reserved for "no valid session was presented at all",
 * the same split `/api/cases/[id]/documents/[docId]/edit` and
 * `/api/invoices/[id]/report` draw.
 *
 * **Everything else folds into `not_found`** - unparsable JSON, a body that
 * fails the schema above, and every rejection `createCase` reports. PRD §8.1
 * has no validation-failure code, and more importantly `createCase`
 * deliberately returns the same `null` for "not yours", "does not exist", "a
 * finding id that is not on that invoice", "already contested" and "the
 * invoice has no issuer" precisely so no caller can tell them apart. A route
 * that answered a malformed body differently would hand back the one bit of
 * information the db layer went to the trouble of withholding: it would
 * confirm that a well-formed request had reached a real row.
 *
 * **This route records no event.** `createCase` writes `case_created`
 * itself, inside the same transaction as the case row and the flip of its
 * findings to `contested`, so principle A3's trail cannot come apart from
 * the transition it describes. That is deliberately unlike
 * `editCaseDocument`, whose route records `contest_edited`. A second
 * `case_created` written here would be a duplicate of a row that already
 * exists.
 *
 * **The case opens at `draft`, and this route does not advance it.** §9.1's
 * transition table moves a case out of `draft` on `protocol_entered`, which
 * is E5 Task 5's protocol route - the moment the person actually reports
 * having opened the SAC ticket. Creating the case is not that moment, so
 * `nextStage` is not this route's to call.
 *
 * The case does, however, open **with a deadline**: RF-186's 30-day
 * protocol window, stamped by `createCase` itself. It is not a playbook
 * deadline (§20.2 has no `draft` entry) but the window RF-186 counts a
 * *person's* silence in, and without it the case is invisible to E5 Task
 * 3's scan - which filters on `next_deadline_at IS NOT NULL` - so it would
 * get no day-30 nudge and be abandoned at day 60 with nothing recorded.
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

  const { db } = container();
  const session = await resolveSession(sessionId, db);
  const scoped = withUser(session, db);

  const caseId = await scoped.createCase(parsed.data);
  if (!caseId) return apiError("not_found");

  return Response.json({ caseId }, { status: 201 });
}
