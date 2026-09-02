import { cookies } from "next/headers";
import { z } from "zod";
import { ContestDocument } from "@pentefino/core";
import { resolveSession, withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

const Body = z.object({ body: ContestDocument });

/**
 * PRD §8.2/RF-164. `case_documents.body` is what the generator produced;
 * `edited_body` is what the person actually sent, once they change anything
 * - both stay readable through `caseDocument`/`editCaseDocument`
 * (packages/db/src/with-user.ts). This route is the only write path to
 * `edited_body`, and it never touches `body`: that is `INV-003` at the data
 * layer, not just in the generated text - the record has to be able to say
 * whether the words a person sent were their own or the generator's, and
 * overwriting `body` here would destroy exactly that distinction.
 *
 * `INV-008`: a document belongs to a case, a case belongs to a user, and
 * `cases.userId` is NOT NULL (`packages/db/src/with-user.ts`'s own header
 * comment) - an anonymous session can never own a case, so it can never own
 * a document either. `resolveSession` turns this request's raw `sessionId`
 * cookie into whichever `Session` `withUser` should actually scope on: a
 * session RF-147 has since claimed resolves to that `userId`; every other
 * session - never claimed, or claimed under a different account entirely -
 * resolves to a bare `{ sessionId }`, which every case-scoped method below
 * already treats as owning nothing. That is why an unclaimed-but-valid
 * session gets the same `not_found` a wrong owner would, never `forbidden`:
 * `forbidden` here is reserved for "no valid session was presented at all",
 * the same split `/api/findings/[id]/feedback` draws.
 *
 * `editCaseDocument` takes both the case id and the doc id straight from
 * this route's own URL and checks the two belong together, not just that
 * the doc belongs to this user - a caller who owns more than one case could
 * otherwise name the right document under the wrong case and still succeed.
 * Ownership failure, a case/doc pair that does not match, and a doc id that
 * does not exist at all all fold into the same `not_found`
 * (`packages/db/src/with-user.ts`'s own doc comment on `editCaseDocument`),
 * so nothing here ever tells a caller which of those it hit.
 *
 * A malformed body (unparsable JSON, or one that fails `ContestDocument`'s
 * own schema) is rejected the same `not_found` way, for the same reason
 * `/api/findings/[id]/feedback` does it: PRD §8.1 has no dedicated
 * validation-failure code, so a body this route cannot use is already an
 * anomaly indistinguishable in kind from "this id is not yours".
 *
 * What this route deliberately does not do: run the §14.3 vocabulary lint
 * (`lintUserFacingText`, RF-162) against the edit. That lint exists to stop
 * the *product* from asserting things it must not - forbidden legal terms,
 * promised outcomes - in text the product generates. An edit is not the
 * product's text; it is the person's own words, about their own case, in a
 * document the person is the sole author of (`INV-003`). Rejecting "advogado"
 * in someone's own sentence would not be enforcing that invariant, it would
 * be the product policing what a person is allowed to say about their own
 * complaint - the opposite of what `INV-003` is for. Nothing downstream
 * sends this text anywhere on the person's behalf either (`INV-002`): the
 * product still only ever hands back text and a deep link, so there is no
 * point at which an unlinted edit could be mistaken for the system's own
 * claim.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; docId: string }> }) {
  const { id: caseId, docId } = await ctx.params;
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

  const updated = await scoped.editCaseDocument(caseId, docId, parsed.data.body);
  if (!updated) return apiError("not_found");

  await scoped.recordEvent(
    "contest_edited",
    { docId, stage: updated.stage, kind: updated.kind },
    undefined,
    caseId,
  );

  return Response.json({ ok: true });
}
