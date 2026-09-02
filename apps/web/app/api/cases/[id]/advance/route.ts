import { cookies } from "next/headers";
import { z } from "zod";
import { resolveSession, withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

const Body = z.object({
  reason: z.enum(["user_request", "response_received"]),
  // What the channel actually said, in the person's own words. Passed
  // straight through: `advanceCase` masks it (INV-007) before it reaches
  // either `case_protocols.response_summary` or the event payload, both of
  // which are durable. Masking it here as well would be a second, silent
  // copy of a rule that already has one owner, and would hide from every
  // test whether the owner still applies it.
  responseSummary: z.string().trim().min(1).max(2_000).optional(),
}).superRefine((value, context) => {
  // A summary of an answer, on a request that is not reporting an answer,
  // has nowhere to go: `advanceCase` fills the open protocol's
  // `responseSummary` only on `response_received`, so accepting it here
  // would silently drop text the person wrote.
  if (value.reason !== "response_received" && value.responseSummary !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["responseSummary"], message: "only with response_received" });
  }
});

/**
 * PRD §8.2, `POST /api/cases/:id/advance` — the two ways a case moves that
 * are neither a protocol nor a close.
 *
 * **`response_received`**: the channel answered. §9.1 keeps the stage where
 * it is and clears the wait — the wait existed to detect silence, and
 * escalating afterwards on a clock that already got its answer would
 * escalate on a false premise. The open protocol for the current stage is
 * stamped with the arrival and the summary, which is what RF-187's dossier
 * and E6's diff read. A case whose current stage has no open protocol is
 * `not_found`: a channel cannot have answered a message that was never sent,
 * and reporting success while filling nothing would leave a case claiming an
 * answer no protocol records.
 *
 * **`user_request`**: the person escalates now instead of waiting the clock
 * out. §9.1 draws no separate edge for that — its only way onwards from a
 * channel is the one marked "prazo vencido" — so that is the transition
 * taken, and **no `deadline_expired` event is written**. RF-182 reads those
 * rows to decide whether a document may state that a company let a deadline
 * pass; a row written here would put that claim on a letter sent to the very
 * company that could disprove it. What is recorded is `stage_advanced` with
 * `reason: "user_request"`, which is true.
 *
 * A `user_request` on a stage with no protocol is §9.1's `stalled`
 * sub-state, not an escalation: the table sends it back to `sac` with
 * RF-186's window restarted, because there is no company silence to escalate
 * against and every channel past `sac` needs the previous protocol to file
 * at all (§20.2's `requiresPreviousProtocol`). The response says so — it
 * carries the stage the case is actually in afterwards, which may not be the
 * one the person expected.
 *
 * **§8.2 gives no response shape for this endpoint.** It returns
 * `{ stage, nextDeadlineAt }` — the same two facts the protocol route
 * returns, and the two a screen has to redraw. `{ ok: true }` (the close
 * route's shape) would have forced a second round trip to learn where the
 * case went, on the one endpoint whose whole purpose is moving it.
 *
 * **INV-008 and the event ownership** are the protocol route's, unchanged:
 * `forbidden` only for a missing session, `not_found` for everything else,
 * and every event written inside `advanceCase`'s own transaction.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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

  // Spread conditionally rather than passing `parsed.data` through: under
  // `exactOptionalPropertyTypes` an absent optional and one explicitly set
  // to `undefined` are different types, and `advanceCase` declares the
  // narrow one.
  const { reason, responseSummary } = parsed.data;
  const result = await scoped.advanceCase(id, {
    reason,
    ...(responseSummary === undefined ? {} : { responseSummary }),
  });
  if (!result) return apiError("not_found");

  return Response.json({
    stage: result.stage,
    nextDeadlineAt: result.nextDeadlineAt?.toISOString() ?? null,
  });
}
