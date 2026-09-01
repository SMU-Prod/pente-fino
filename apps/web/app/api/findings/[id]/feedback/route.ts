import { cookies } from "next/headers";
import { z } from "zod";
import { withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

const Body = z.object({
  action: z.enum(["dismiss", "confirm"]),
  answer: z.string().optional(),
});

const STATUS_BY_ACTION = {
  dismiss: "dismissed_by_user",
  confirm: "confirmed_by_user",
} as const;

const EVENT_BY_ACTION = {
  dismiss: "finding_dismissed",
  confirm: "finding_confirmed",
} as const;

/**
 * PRD §8.2. This is the only source of the `dismissed`/`confirmed` signal
 * RF-126 (auto-promote a `shadow` rule) and RF-127 (auto-pause an `active`
 * one) read off `rule_metrics` - without this endpoint recording that
 * signal, a rule seeded into shadow mode has no way to ever leave it, and a
 * rule wrongly accusing people has no automatic brake.
 *
 * INV-008: identical shape to `/api/invoices/[id]/report` - `forbidden`
 * (403) when no valid session was presented at all, `not_found` (404) when
 * the session is valid but the finding either does not exist or belongs to
 * someone else. `setFindingFeedback` (packages/db/src/with-user.ts) folds
 * "not owned" and "does not exist" into the same `null`, so this route
 * cannot leak which one it was - a caller can never learn whether a finding
 * id is real by the shape of the error.
 *
 * A malformed body (unknown `action`, unparsable JSON) is rejected the same
 * way as an unknown finding id, for the same reason: PRD §8.1's error
 * catalogue has no dedicated validation-failure code, and the two real
 * clients of this route only ever send one of the two known actions, so a
 * body that fails to parse is already an anomaly indistinguishable in kind
 * from "this id is not yours" - both are cases where nothing should be
 * written and no extra information should be handed back.
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
  const { action, answer } = parsed.data;

  const { db } = container();
  const scoped = withUser({ sessionId }, db);
  const owned = await scoped.setFindingFeedback(id, STATUS_BY_ACTION[action]);
  if (!owned) return apiError("not_found");

  // `ruleSlug` and `ruleVersion` are not decoration: rule-metrics.ts skips
  // any feedback event missing either, so without them `dismissed` stays at
  // zero and RF-126 promotes every shadow rule on its 30th firing no matter
  // how many people rejected it.
  await scoped.recordEvent(
    EVENT_BY_ACTION[action],
    {
      ruleSlug: owned.ruleSlug,
      ruleVersion: owned.ruleVersion,
      ...(answer === undefined ? {} : { answer }),
    },
    owned.invoiceId,
  );

  return Response.json({ ok: true });
}
