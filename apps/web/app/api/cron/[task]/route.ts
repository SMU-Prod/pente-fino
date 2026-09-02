import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { container } from "../../../../lib/container.js";

/**
 * The scheduler surface. Vercel Cron calls `GET /api/cron/<task>`; this
 * route enqueues the matching handler from `container()`.
 *
 * ---------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------
 *
 * Nothing scheduled anything. Every "daily job" this codebase has was
 * registered in `container()` and then never invoked — `lib/container.ts`
 * says so in three separate comments ("no scheduler is wired up yet in this
 * slice"), each written by a task that correctly judged the scheduler was
 * not its job. Four requirements were capable and not live:
 *
 *  - **RF-110** file expiry. `fileExpiresAt` passes and the invoice PDF
 *    stays in the bucket. This is a retention promise made to a person who
 *    uploaded a document with their CPF on it, and it was not being kept.
 *  - **RF-302** rule metrics. `rule_metrics` is never materialised from
 *    `events`.
 *  - **RF-126 / RF-127** promotion and pause. Both read `rule_metrics`, so
 *    both were reading a table nothing wrote: no rule is ever proposed for
 *    promotion, and — worse — no rule is ever paused for firing badly.
 *  - **RF-180** the case-deadline sweep. Deadlines expire and nothing
 *    notices, which makes E5's whole point inert.
 *  - **RF-187** the dossier sweep. A case reaches `jec_ready` and the
 *    document it exists to produce is never produced.
 *
 * This list grows by merge, silently: a task registered in `container()`
 * and not listed in `SCHEDULABLE` below is exactly as dead as it was
 * before this route existed. `apps/web/test/routes/cron.test.ts` pins the
 * two lists against each other for that reason.
 *
 * None of these fail loudly. They are jobs that do not run, and a job that
 * does not run looks exactly like a job with nothing to do.
 *
 * ---------------------------------------------------------------------
 * ORDER
 * ---------------------------------------------------------------------
 *
 * `ruleLifecycle` reads the rows `ruleMetrics` writes, so it must run after
 * it — `lib/container.ts` states this and notes it is a scheduler concern.
 * `vercel.json` separates them by an hour rather than chaining them, so a
 * slow or failed metrics run delays a promotion decision by a day instead
 * of coupling the two jobs into one that half-succeeds.
 *
 * ---------------------------------------------------------------------
 * AUTHENTICATION
 * ---------------------------------------------------------------------
 *
 * This endpoint runs system-wide work with no user session, so it is
 * reachable by anyone who can reach the app. It is closed by default in
 * both directions:
 *
 *  - With no `CRON_SECRET` set it refuses every request (503). It does NOT
 *    fall open. A misconfigured deploy that silently accepted anonymous
 *    calls would hand a stranger the ability to expire a person's files.
 *  - The comparison is `timingSafeEqual` on fixed-length digests, not
 *    `===`, and length is checked before the compare.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically for
 * paths listed in `vercel.json`. RNF-12 puts the secret in Vercel's own
 * environment, never in a file.
 */

export const dynamic = "force-dynamic";

/**
 * The tasks a scheduler may start, and nothing else. `container()`'s
 * handler map also holds `ingest`, which takes an `invoiceId` and belongs
 * to a user's upload — an allowlist keeps this route from becoming a way to
 * invoke arbitrary registered work by guessing its name.
 */
const SCHEDULABLE = ["expireFiles", "ruleMetrics", "ruleLifecycle", "caseDeadlines", "dossier"] as const;

function isSchedulable(task: string): task is (typeof SCHEDULABLE)[number] {
  return (SCHEDULABLE as readonly string[]).includes(task);
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(secret);
  // `timingSafeEqual` throws on a length mismatch, which would itself leak
  // length through the error path; compare lengths first and return the
  // same `false` either way.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ task: string }> },
) {
  if (!process.env.CRON_SECRET) {
    // Distinct from 401 on purpose: this is the deploy being wrong, not the
    // caller. A 401 here would send an operator hunting for a bad secret
    // when the real problem is that there is no secret at all.
    return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { task } = await params;
  if (!isSchedulable(task)) {
    return NextResponse.json({ error: "unknown_task" }, { status: 404 });
  }

  try {
    const { queue } = container();
    const result = await queue.enqueue(task, {});
    return NextResponse.json({ task, runId: result.runId });
  } catch (error) {
    // A failed scheduled job must be visible (A8). Returning 200 here would
    // make a job that throws every night indistinguishable from one with
    // nothing to do — which is the failure this whole route exists to end.
    console.error(`cron: task "${task}" failed`, error);
    return NextResponse.json(
      { error: "task_failed", task, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
