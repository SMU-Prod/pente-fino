import { cookies } from "next/headers";
import { withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { loadReport } from "@/lib/report.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

/**
 * INV-008: the read path is the one place a leak would matter most - this
 * is the route a shared link, a bookmark, or simple id-guessing would try
 * first. `withUser` scopes both `invoices()` and `findingsForInvoice()` to
 * the caller's own session, and "no valid session" and "valid session, not
 * the owner" are handled by two different, deliberately non-overlapping
 * codes: `forbidden` (identity unknown) vs. `not_found` (identity known,
 * but this is not theirs) - one session can never distinguish "this invoice
 * does not exist" from "this invoice exists and is someone else's" once it
 * has proven who it is.
 *
 * The report's shape (bands, aggregates, totals) lives in `@/lib/report.js`,
 * shared with the `/laudo/[id]` server component so both read the exact same
 * classification and clustering logic instead of two implementations that
 * could quietly drift apart.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  const { db } = container();
  const scoped = withUser({ sessionId }, db);
  const report = await loadReport(scoped, id);
  if (!report) return apiError("not_found");

  await scoped.recordEvent("report_viewed", {}, id);
  return Response.json(report);
}
