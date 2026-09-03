// eslint-disable-next-line pentefino/require-with-user -- proposals are system configuration, not one user's data (packages/db/src/admin.ts's own header); RF-304's queue has no session to scope by withUser.
import { listProposals } from "@pentefino/db";
import { requireAdmin } from "@/lib/admin.js";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";

/**
 * `GET /api/admin/proposals` — RF-304's approval queue. `?all=1` includes
 * already-decided proposals; the default is pending-only, the set a human
 * actually needs to act on (see `listProposals`'s own doc comment).
 *
 * **A non-admin gets `not_found`, never `forbidden`** — same reasoning as
 * every other route in this block.
 */
export async function GET(request: Request) {
  const { db } = container();
  const admin = await requireAdmin(db);
  if (!admin) return apiError("not_found");

  const includeDecided = new URL(request.url).searchParams.get("all") === "1";
  const proposals = await listProposals(db, { includeDecided });
  return Response.json({ proposals });
}
