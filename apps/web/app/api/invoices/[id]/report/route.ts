import { cookies } from "next/headers";
import { withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
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
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  const { db } = container();
  const scoped = withUser({ sessionId }, db);
  const invoice = (await scoped.invoices()).find((row) => row.id === id);
  if (!invoice) return apiError("not_found");

  const findings = await scoped.findingsForInvoice(id);
  const suspectCents = findings.reduce((acc, f) => acc + f.amountCents, 0);
  const doubledCents = findings.reduce((acc, f) => acc + (f.doubledCents ?? 0), 0);
  // PRD §8.2 declares `issuer` in this response's shape; loaded through the
  // same ownership-scoped path (`scoped`, from `withUser`) as `findings`
  // above, and `null` when the invoice has no issuer assigned yet.
  const issuer = await scoped.issuerForInvoice(id);

  await scoped.recordEvent("report_viewed", { invoiceId: id });
  return Response.json({ invoice, findings, totals: { suspectCents, doubledCents }, issuer });
}
