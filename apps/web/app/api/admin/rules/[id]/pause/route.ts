import { z } from "zod";
// eslint-disable-next-line pentefino/require-with-user -- rules are system configuration, not one user's data (packages/db/src/admin.ts's own header); RF-301's admin CRUD has no session to scope by withUser.
import { pauseRuleVersion } from "@pentefino/db";
import { requireAdmin } from "@/lib/admin.js";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";

const Body = z.object({ reason: z.string().min(1) });

/**
 * `POST /api/admin/rules/:id/pause` — a human's off-switch for an `active`
 * or `shadow` rule. Deliberately reuses the `rule_paused` event RF-127's
 * automatic pause also writes (see `pauseRuleVersion`'s own doc comment for
 * why `decidedBy`'s presence, not the event name, is what distinguishes a
 * human pause from an automatic one). `actor` is the authenticated admin's
 * e-mail, never a body field.
 *
 * **A non-admin gets `not_found`, never `forbidden`** — same reasoning as
 * every other route in this block.
 *
 * A malformed body folds into `not_found`. `pauseRuleVersion` itself throws
 * for a nonexistent rule and for one that is already `draft` or `paused`;
 * both fold into `not_found` too, the same "does not exist" /
 * "not in a state this action can touch" collapse `activate/route.ts` makes.
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

  try {
    await pauseRuleVersion(db, { ruleId: id, actor: admin.email, reason: parsed.data.reason });
  } catch (error) {
    console.error(`admin/rules/${id}/pause: failed`, error);
    return apiError("not_found");
  }

  return Response.json({ ok: true });
}
