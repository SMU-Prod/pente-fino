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
 * than inferred from whatever the `cases` row currently says.
 *
 * It is this case's own history, and deliberately not the widest history
 * that could be assembled about it. Everything here is scoped on
 * `events.case_id`, because this response is what a person reads on their
 * own case screen and a case's screen shows what happened to that case. E5
 * Task 7's dossier is a different view of the same table and builds its own,
 * *wider* query - case-scoped rows OR the invoice-scoped
 * `invoice_uploaded` / `invoice_analyzed` / `invoice_file_expired` ones,
 * because `invoice_file_expired` carries no `caseId` at all and a dossier
 * assembled for a company has to account for the file that is no longer
 * there. It is a system job and does not call `caseDetail`. So the two
 * timelines differ on purpose, and neither is the other's bug: widening this
 * one to match the dossier would put invoice-level history on a case screen,
 * and narrowing the dossier to this one would drop the rows it exists to
 * explain.
 *
 * **INV-007.** Everything returned here is user-facing, and it now carries
 * free text the person typed - a close note - alongside generated
 * documents. The note is masked at write time, inside `closeCase`, before
 * it ever reaches `events.payload`; this route does not re-mask, because
 * masking a value that is already stored masked would only hide whether the
 * write path is still doing its job.
 *
 * **This route records `case_viewed`, after ownership is proved.** RF-185
 * wants reminders suppressed when the person opened the case in the last 24
 * hours, which needs a recorded "opened" fact to read; `case_viewed`
 * (`packages/core/src/events.ts`) is that fact, added by E5 Task 6 for
 * exactly this. The call sits after the `!detail` check, never before, for
 * two reasons. First, Task 4's report (risk R5) found that `recordEvent`'s
 * `caseId` is caller-supplied and never ownership-checked on its own; a
 * stranger probing `/api/cases/<guessed-id>` must not be able to inject a
 * row into someone else's timeline, and `caseDetail` returning non-null is
 * the ownership proof this route has. Second, INV-008: a `forbidden` or
 * `not_found` response must leave no trace that differs from any other, and
 * writing the row before either check would leave exactly such a trace. The
 * write is awaited before the response is built, the same way
 * `apps/web/app/laudo/[id]/page.tsx` awaits its own `report_viewed` write -
 * a fire-and-forget write in a serverless function is a write that may not
 * happen. Both ids are stamped (`detail.case.invoiceId` and `id`) so the
 * event can be correlated with the invoice, not only the case (Task 15's
 * finding in `.superpowers/sdd/progress.md`); the payload is `{}`, because
 * there is nothing to put in it that is not already a column. This is not an
 * A3 state transition - nothing about the case changes when someone looks at
 * it - which is why the catalogue's own doc comment says so plainly rather
 * than dressing it up as one; see `events.ts` for the full reasoning.
 * `timeline` below still returns this row exactly as `caseDetail` produces
 * it, same as every other row - a rendering decision to filter `case_viewed`
 * out of what a screen displays belongs to that screen (E5 Task 6B), not to
 * this data endpoint.
 *
 * **`protocolToken` is stripped from the serialised case.** It is the
 * workflow's `wait.forToken` handle (`packages/db/src/schema.ts`) - a
 * capability, not a fact about the dispute: whoever holds it can resume the
 * run this case is waiting on, and E5 Tasks 3 and 5 use it server-side, from
 * the case row they read themselves. Nothing in this response consumes it,
 * so shipping it to a browser would only widen where it can leak from - a
 * screenshot, a client-side log, a `fetch` in a devtools tab - with nothing
 * gained. `caseDetail` still returns it, deliberately: its other callers are
 * the ones that need it, and narrowing the method would take it away from
 * them to solve a problem only this boundary has.
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

  await scoped.recordEvent("case_viewed", {}, detail.case.invoiceId, id);

  // Destructured away rather than rebuilt key by key: a column added to
  // `cases` later should reach this response by default, and only the one
  // named here should have to be argued for.
  const { protocolToken: _protocolToken, ...serialisableCase } = detail.case;
  return Response.json({ ...detail, case: serialisableCase });
}
