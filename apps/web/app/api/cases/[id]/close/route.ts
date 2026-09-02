import { cookies } from "next/headers";
import { z } from "zod";
import { CASE_OUTCOMES } from "@pentefino/core";
import { resolveSession, withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

// The enum is built from `CASE_OUTCOMES` itself, never from a re-typed
// literal list: a fifth outcome added to §9.1 must reach this route by
// widening the constant, not by someone remembering that a copy of it lives
// here too.
const Body = z.object({
  outcome: z.enum(CASE_OUTCOMES),
  // Integer cents, non-negative. `closeCase` re-checks this and *throws*
  // rather than returning null - a bad argument is not a missing row - so
  // letting a fractional or negative value through here would surface as a
  // 500, and for some values as a raw database error from the column.
  recoveredCents: z.number().int().min(0).optional(),
  // Free text, passed straight through: `closeCase` masks it (INV-007)
  // before it reaches `events.payload`. The cap only stops an unbounded
  // string from being persisted; it is not a product limit on what someone
  // may say about their own case.
  note: z.string().max(2_000).optional(),
}).superRefine((value, context) => {
  const favourable = value.outcome === "resolved" || value.outcome === "partial";
  if (favourable && value.recoveredCents === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recoveredCents"], message: "required for this outcome" });
  }
  if (!favourable && value.recoveredCents !== undefined && value.recoveredCents > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recoveredCents"], message: "not recovered" });
  }
});

/**
 * PRD §8.2, `POST /api/cases/:id/close` - the person telling the product how
 * their dispute actually ended.
 *
 * **Why the cross-field rule on `recoveredCents` is validation and not a
 * nicety.** §1.4's north-star metric is "reais recuperados confirmados por
 * usuário ativo/mês" - the single number this product is judged by - and
 * `cases.recovered_cents` is where it is read from. A `resolved` or
 * `partial` close with no amount is money the metric silently loses: the
 * column defaults to 0, the case reports a win worth nothing, and no later
 * read can tell that apart from a genuine zero recovery. A `denied` or
 * `abandoned` close carrying a positive amount is the mirror image - money
 * the metric silently invents, on a case where nothing came back. Neither
 * can be repaired downstream, because both produce a perfectly well-formed
 * row. So a favourable outcome requires the amount and an unfavourable one
 * must not carry a positive one. An explicit zero on a `denied` close is
 * accepted: that is an honest statement, not a missing one.
 *
 * **Once, and only once.** A second close returns `not_found`, because
 * `closeCase` folds `closed_at IS NULL` into the same predicate as its
 * ownership check - the close is decided by the write itself, so two
 * concurrent calls cannot both win it. §8.1's catalogue is closed and has no
 * `conflict` code to say "already closed" with, and inventing one would be
 * worse than the omission: the only thing it could add is a way for a caller
 * to learn that a case id exists. The alternative shape - letting a second
 * close through - would emit a second `outcome_confirmed` and double-count
 * the north-star metric on exactly the cases someone clicked twice.
 *
 * **INV-008**, the same split every case route draws: `forbidden` for "no
 * valid session was presented at all", `not_found` for everything else -
 * a case belonging to somebody else, a case that never existed, an already
 * closed case, an unclaimed session that can own no case, and a body this
 * route cannot use. §8.1 has no validation-failure code, and folding them
 * together is what keeps a caller from learning which of them it hit.
 *
 * **This route records no event.** `closeCase` writes `outcome_confirmed`
 * inside the same transaction as the close, deliberately unlike
 * `editCaseDocument`, whose route records `contest_edited` itself. Here a
 * route-written event would not merely be late but unrepairable: the close
 * is one-shot, so a crash between the two would leave a closed case whose
 * `outcome_confirmed` can never be written at all - and a duplicate written
 * here would double-count the very metric the one-shot guard exists to
 * protect.
 *
 * **`note` is not masked here.** `closeCase` runs `maskText` over it on the
 * way into `events.payload` (INV-007). Masking it again in the route would
 * be a second, silent copy of a rule that already has one owner, and would
 * hide from every test whether the owner is still applying it.
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

  // Spread conditionally rather than passing `parsed.data` straight through:
  // under `exactOptionalPropertyTypes` an absent optional and one explicitly
  // set to `undefined` are different types, and `closeCase` declares the
  // narrow one. `closeCase` reads both fields with `!== undefined`, so
  // omitting the key is also what it actually means to say nothing here.
  const { outcome, recoveredCents, note } = parsed.data;
  const closed = await scoped.closeCase(id, {
    outcome,
    ...(recoveredCents === undefined ? {} : { recoveredCents }),
    ...(note === undefined ? {} : { note }),
  });
  if (!closed) return apiError("not_found");

  return Response.json({ ok: true });
}
