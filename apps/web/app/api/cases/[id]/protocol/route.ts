import { cookies } from "next/headers";
import { z } from "zod";
import { STAGES } from "@pentefino/core";
import { resolveSession, withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

// The enum is built from `STAGES` itself, never a re-typed literal list —
// the same choice the close route makes for `CASE_OUTCOMES`, for the same
// reason: a stage added to §9.1 must reach this route by widening the
// constant, not by someone remembering a copy of it lives here too.
const Body = z.object({
  stage: z.enum(STAGES),
  // The number a channel gave the person, typed by hand off a screen or read
  // back from a phone call. The cap only stops an unbounded string reaching
  // a durable column; it is not a claim about what a protocol number looks
  // like, and no format is imposed — every issuer numbers its own way, and a
  // rejected-but-real protocol number is a person locked out of their own
  // case.
  protocolNumber: z.string().trim().min(1).max(60),
  // The channel as the person names it. Sent by the client rather than read
  // from the playbook on purpose: the playbook's `channel` is the reference
  // name ("SAC da operadora"), and what belongs on the document is where the
  // person actually filed — which for a telecom SAC may be a specific store,
  // an app or a phone line.
  channel: z.string().trim().min(1).max(120),
  // ISO 8601 with an offset, so the instant is unambiguous. A bare local
  // datetime would be read as UTC and land the deadline a day out for
  // anything registered in the evening — the exact failure
  // `packages/core/src/cases/deadline.ts`'s third decision exists to
  // prevent, arriving through the front door instead.
  registeredAt: z.string().datetime({ offset: true }),
});

/**
 * PRD §8.2, `POST /api/cases/:id/protocol` — RF-184. The person pastes the
 * number the channel gave them; the case stops waiting on RF-186's 30-day
 * protocol window and starts waiting on that channel's own deadline.
 *
 * **"O workflow retoma em menos de 30 s", and where that budget goes.**
 * ADR-02 named Trigger.dev, whose shape for this is a run parked on a wait
 * token released by a later signal. What exists is a row in
 * `cases.next_deadline_at` and a job that scans it (E5 Task 3) — so the wait
 * is not something this route notifies, it is something this route
 * *rewrites*. `recordProtocol` does it inside the transaction that records
 * the protocol, before the response is returned. Nothing is enqueued and no
 * scheduled sweep participates, so the resume time is one database round
 * trip and cannot drift with queue depth or the sweeper's interval. The
 * failure mode the 30 s exists to rule out — a person who pastes a protocol,
 * sees "recebido", and is escalated anyway two hours later because the wait
 * had not actually been released — is unreachable by construction rather
 * than by being fast enough.
 *
 * **`stage` is a staleness check.** `recordProtocol` requires it to equal
 * the stage the protocol will attach to, which is `nextStage`'s own answer —
 * so `draft` and `sac` are the same submission (§9.1: a protocol number *is*
 * the person having written to the channel). A client a stage behind cannot
 * file a SAC protocol against a case that already escalated, where it would
 * sit as the wrong channel's evidence for the rest of the case's life.
 *
 * **INV-008**, the split every case route draws: `forbidden` when no valid
 * session was presented at all, `not_found` for everything else — a case
 * belonging to someone else, a case that never existed, a closed case, a
 * stale `stage`, a `registeredAt` in the future, and a body this route
 * cannot use. §8.1's catalogue has no validation code, and folding them
 * together is what stops a caller learning which one it hit.
 *
 * **This route records no event.** `recordProtocol` writes
 * `protocol_entered` (and `stage_advanced`, when the stage moved) inside the
 * same transaction as the row and the deadline. A route-written event could
 * be lost by a crash after the commit, leaving a case whose wait had
 * restarted with nothing in the trail saying why — and RF-182's document
 * reads that trail.
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

  const result = await scoped.recordProtocol(id, {
    stage: parsed.data.stage,
    protocolNumber: parsed.data.protocolNumber,
    channel: parsed.data.channel,
    registeredAt: new Date(parsed.data.registeredAt),
  });
  if (!result) return apiError("not_found");

  // §8.2's stated shape. `nextDeadlineAt` is null only for a stage the
  // issuer's playbook does not describe (§20.2 declares no `ombudsman` and
  // no `procon`, and gives `jec_ready` `responseDays: 0`) — the honest
  // answer of "this channel owes no waiting period", not a failure.
  return Response.json({ nextDeadlineAt: result.nextDeadlineAt?.toISOString() ?? null });
}
