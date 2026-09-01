import { cookies } from "next/headers";
import { withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { createStatusStream, SSE_HEADERS } from "@/lib/status-stream.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

/**
 * RF-141 / §8.2: `GET /api/invoices/:id/status` streams
 * `{ status, step, progressPct }` over Server-Sent Events, built from the
 * same `events` rows the ingest task writes (see `@/lib/status-stream.js`'s
 * doc comment for why a durable row, not a live-only push, is what makes the
 * three cases below possible at all).
 *
 * INV-008: the same ownership check the report route makes, and for the
 * same reason - this is a read of user data, and a stream is not exempt
 * from that just because it is long-lived. No session at all is `forbidden`
 * (identity unknown); a session that does not own this invoice id is
 * `not_found`, identical to an id that does not exist - one response can
 * never tell those two apart once a session has proven who it is.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  const { db } = container();
  const scoped = withUser({ sessionId }, db);
  const owned = (await scoped.invoices()).find((row) => row.id === id);
  if (!owned) return apiError("not_found");

  const stream = createStatusStream(() => scoped.eventsForInvoice(id), { signal: request.signal });
  return new Response(stream, { headers: SSE_HEADERS });
}
