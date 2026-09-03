import { z } from "zod";
// eslint-disable-next-line pentefino/require-with-user -- proposals are system configuration, not one user's data (packages/db/src/admin.ts's own header); RF-304's decision has no session to scope by withUser.
import { rejectProposal } from "@pentefino/db";
import { applyRulePromotionProposal } from "@pentefino/jobs";
import { requireAdmin } from "@/lib/admin.js";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";

const Body = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1),
});

/**
 * `POST /api/admin/proposals/:id` — PRD §18's acceptance criterion for the
 * whole of block E11: "Proposta aplicada gera evento". `decision: "approve"`
 * is the one HTTP path this codebase has to `applyRulePromotionProposal`
 * (`apps/jobs/src/tasks/rule-lifecycle.ts`), the only function anywhere
 * allowed to set `rules.status = 'active'` (global constraint 7). This
 * route does not reimplement any part of it — it imports and calls the
 * function directly, exactly as `scripts/proposals.mjs`'s `approve` command
 * already does, and passes it the same three inputs: the proposal id from
 * the URL, `decidedBy` = the authenticated admin's e-mail (never a body
 * field, same discipline as `author` on `POST /api/admin/rules`), and
 * `decisionReason` = the body's `reason`.
 *
 * `reason` is required and non-empty here, not optional, because
 * `applyRulePromotionProposal` types `decisionReason` as a required
 * `string` — `scripts/proposals.mjs` can pass `undefined` (when `--reason`
 * is omitted on the command line), and this route must not repeat that gap:
 * a promotion decision with no real reason string is not the kind of
 * decision §18's "leitura manual de cada descarte" bar has in mind.
 *
 * `decision: "reject"` calls `rejectProposal` instead — the mirror image
 * that changes no rule at all (see its own doc comment in
 * `packages/db/src/admin.ts`).
 *
 * Both can throw: no such proposal, a proposal that is not `promote_rule`
 * (approve only), a proposal already decided, or — approve only — a target
 * rule that is no longer `shadow`. None of those four is exposed to the
 * caller. The raw error is logged server-side, the same way
 * `apps/web/app/api/cron/[task]/route.ts` logs a failed scheduled task, and
 * every one of them answers the same generic `409` (`proposal_conflict`,
 * `apps/web/lib/errors.ts`) — a caller probing this endpoint should not be
 * able to learn, from the response alone, which of the four it hit.
 *
 * **A non-admin gets `not_found`, never `forbidden`** — same reasoning as
 * every other route in this block. A malformed body (unparsable JSON, or one
 * missing `decision`/`reason`) folds into `not_found` too, for the same
 * "no dedicated validation-failure code" reason every other route here
 * gives.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { db } = container();
  const admin = await requireAdmin(db);
  if (!admin) return apiError("not_found");

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiError("not_found");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return apiError("not_found");

  const { decision, reason } = parsed.data;

  try {
    if (decision === "approve") {
      await applyRulePromotionProposal({ db }, { proposalId: id, decidedBy: admin.email, decisionReason: reason });
    } else {
      await rejectProposal(db, { proposalId: id, decidedBy: admin.email, decisionReason: reason });
    }
  } catch (error) {
    console.error(`admin/proposals/${id}: decision "${decision}" failed`, error);
    return apiError("proposal_conflict");
  }

  return Response.json({ ok: true });
}
