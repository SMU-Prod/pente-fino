// eslint-disable-next-line pentefino/require-with-user -- rules are system configuration, not one user's data (packages/db/src/admin.ts's own header); RF-301's admin CRUD has no session to scope by withUser.
import { activateRuleVersion } from "@pentefino/db";
import { requireAdmin } from "@/lib/admin.js";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";

/**
 * `POST /api/admin/rules/:id/activate` — RF-125's only `draft` → `shadow`
 * move. `actor` is the authenticated admin's e-mail, the same `author`/
 * `decidedBy` discipline every other admin-write route in this block
 * follows — never a body field, since there is no body to read one from.
 *
 * **A non-admin gets `not_found`, never `forbidden`**, for the same reason
 * `rules/route.ts`'s `GET` does: a 403 would confirm this surface exists to
 * anyone who probes it.
 *
 * `activateRuleVersion` throws (it has no sentinel return) for two distinct
 * reasons — no `rules` row with this id, or a row that is not currently
 * `draft` — and both fold into the same `not_found` here, the way this
 * codebase already folds "does not exist" and "not in a state this action
 * can touch" together elsewhere (e.g. `/api/cases/:id/close`'s doc comment).
 * Nothing here should teach a caller to tell those two apart from the
 * response alone.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { db } = container();
  const admin = await requireAdmin(db);
  if (!admin) return apiError("not_found");

  try {
    await activateRuleVersion(db, { ruleId: id, actor: admin.email });
  } catch (error) {
    console.error(`admin/rules/${id}/activate: failed`, error);
    return apiError("not_found");
  }

  return Response.json({ ok: true });
}
