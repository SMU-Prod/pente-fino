import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { maskText, newId, type CaseOutcome, type EventType } from "@pentefino/core";
import { getUnscopedDb } from "./client.js";
import { cases, events, findings } from "./schema.js";

type Db = ReturnType<typeof getUnscopedDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Closing a case, for the two callers that have to do it — and the reason
 * they cannot each do it their own way.
 *
 * `withUser`'s `closeCase` is the person saying how their dispute ended.
 * RF-186's day-60 sweep is the system saying nobody ever came back. Both
 * move `cases.stage` to `closed`; both must also move the case's findings
 * out of `contested`, and only the first one ever did.
 *
 * **What the missing half costs.** `findings.status` has six values, and
 * `contested` means "a case is actively disputing this charge"
 * (`with-user.ts`). `VISIBLE_FINDING_STATUSES` shows a `contested` finding
 * on the report as a live dispute; `CONTESTABLE_FINDING_STATUSES` refuses to
 * let one into a new case, so the same money cannot be counted twice. Both
 * of those are correct *while a case is running*. A case that closes without
 * settling its findings leaves them there permanently: the report keeps
 * claiming a dispute that ended months ago, and the person can never contest
 * that charge again — on exactly the money §1.4's north-star metric is
 * counted from, and for the people whose case was abandoned because nothing
 * happened, who are the least likely to be told why.
 *
 * So the settlement lives here rather than inside either caller, and
 * `closeCaseAsSystem` exists so a job never has to remember to call it:
 * there is one function that closes a case without a session, and it does
 * the whole thing.
 */

/**
 * What a case's findings become when it closes, per §9.1's four outcomes.
 *
 * `partial` maps to `unresolved`, not `resolved`, and that is deliberate:
 * a case records *how much* came back but never *which findings* the partial
 * recovery covered, so marking them resolved would hide money from the
 * report that was never actually recovered. `denied` and `abandoned` are the
 * same story with nothing recovered at all — the charge is exactly as live
 * as it was before, just with a failed attempt behind it, which is what
 * `unresolved` says and why `CONTESTABLE_FINDING_STATUSES` lets it back into
 * a new case.
 */
export const SETTLED_FINDING_STATUS: Record<CaseOutcome, "resolved" | "unresolved"> = {
  resolved: "resolved",
  partial: "unresolved",
  denied: "unresolved",
  abandoned: "unresolved",
};

/**
 * Moves a closing case's findings out of `contested`. Must run inside the
 * same transaction as the write that closed the case — a settlement that
 * commits separately can be lost by a crash, and what it leaves behind is
 * the permanent dead end described above.
 *
 * Scoped to `status = 'contested'` so it only ever touches findings this
 * case actually took. A finding some *other* case is disputing cannot be in
 * this case's `findingIds` (`CONTESTABLE_FINDING_STATUSES` excludes
 * `contested` at creation), and one the person has since dismissed keeps the
 * status they chose.
 *
 * Returns how many rows it settled, so a caller that wants to assert on it
 * can.
 */
export async function settleCaseFindings(
  tx: Tx,
  input: { findingIds: string[]; outcome: CaseOutcome; at: Date },
): Promise<number> {
  if (input.findingIds.length === 0) return 0;
  const settled = await tx.update(findings)
    .set({ status: SETTLED_FINDING_STATUS[input.outcome], updatedAt: input.at })
    .where(and(inArray(findings.id, input.findingIds), eq(findings.status, "contested")))
    .returning({ id: findings.id });
  return settled.length;
}

/**
 * The mirror image of `settleCaseFindings` above, run by `reopenCase`
 * (`./case-reopen.ts`, E6 Task 3 - RF-203) when the charge a closed case
 * settled turns out to have come back. Kept beside `settleCaseFindings`
 * rather than in `case-reopen.ts` itself: the two are a pair that must keep
 * agreeing about which of `findings.status`'s six values a close (or its
 * undo) is allowed to touch, and that is easiest to keep true when both
 * bodies sit in the same file next to each other rather than in two files a
 * future edit can update one of without noticing the other.
 *
 * Must run inside the same transaction as the write that reopens the case,
 * for the identical crash-safety reason `settleCaseFindings`'s doc comment
 * gives: a reopen that commits without its findings would leave the case
 * escalatable again while the money it was arguing about still reads as
 * settled.
 *
 * Scoped to `status = 'resolved'` only - not the full settled range
 * `SETTLED_FINDING_STATUS` can produce (`resolved` or `unresolved`).
 * `unresolved` already means "still live" (`VISIBLE_FINDING_STATUSES`
 * includes it, `CONTESTABLE_FINDING_STATUSES` in `with-user.ts` lets a new
 * case take it), so a reappearing charge changes nothing about a finding
 * already marked that way - flipping it to `contested` would be a case
 * claiming to dispute a charge no report ever stopped calling live, which
 * is not what RF-203 describes. Only `resolved` - "this exact charge is
 * fixed" - can be falsified by the charge coming back, and only that value
 * needs undoing.
 *
 * This is also what keeps the move safe without re-checking ownership the
 * way `settleCaseFindings`'s own doc comment worries about for its close: a
 * `resolved` finding is never in `CONTESTABLE_FINDING_STATUSES`, so no
 * *other* case could have picked it up in the meantime - there is nothing
 * for this UPDATE to collide with. A finding the person has since dismissed
 * (`dismissed_by_user`) is left alone and keeps the status they chose, the
 * same guarantee `settleCaseFindings` gives on the way in.
 *
 * Returns how many rows it reopened, so a caller that wants to assert on it
 * can, mirroring `settleCaseFindings`'s own return value.
 */
export async function reopenCaseFindings(
  tx: Tx,
  input: { findingIds: string[]; at: Date },
): Promise<number> {
  if (input.findingIds.length === 0) return 0;
  const reopened = await tx.update(findings)
    .set({ status: "contested", updatedAt: input.at })
    .where(and(inArray(findings.id, input.findingIds), eq(findings.status, "resolved")))
    .returning({ id: findings.id });
  return reopened.length;
}

/**
 * Closes a case with no user session behind it — RF-186's day-60
 * abandonment, and any later system close.
 *
 * Deliberately **not** a `withUser` method: there is no session to scope it
 * to, and INV-008 is about a *user's* query reaching another user's data.
 * The case id here comes from a scan this package's own job ran, never from
 * a request body, so there is no ownership to prove and nothing to leak — a
 * caller cannot pass an id it did not first read out of `cases`.
 *
 * For RF-186's abandonment path specifically (`confirmedBy` left at its
 * `"none"` default, below), this is everything `closeCase` does minus the
 * parts that only make sense for a person: no `recoveredCents` (an
 * abandoned case recovered nothing by definition — nobody coming back is not
 * a refund), and `outcomeConfirmedBy: "none"`, the §6.2 value for "no one
 * confirmed this" as opposed to `user` or `diff`. E6's diff close (see
 * `confirmedBy` below) is the other system close, and does carry a
 * confirmation and, sometimes, a `recoveredCents`.
 *
 * **One-shot, like the user close**, and for the same reason: the predicate
 * folds in `closed_at IS NULL` and `stage <> 'closed'`, so a sweep that runs
 * twice over the same case (a retry, two workers) closes it once and returns
 * `null` the second time rather than emitting a second
 * `outcome_confirmed`.
 *
 * **Both events, the same shapes `closeCase` writes** — `outcome_confirmed`
 * saying how it ended, and `stage_advanced` carrying `{ from, to, by,
 * outcome }` so E6 can reconstruct the stage a reopened case belongs back
 * in (RF-203). The only difference is `by: "system"`.
 *
 * `note` is masked here (INV-007) exactly as `closeCase` masks it: the event
 * payload is durable, and a masking step a caller can forget is one that
 * will be forgotten.
 *
 * **`confirmedBy` and `recoveredCents`, added by E6 Task 3 for the other
 * system close.** RF-186's sweep above is the system saying nobody ever
 * came back - it confirms nothing, so `confirmedBy` defaults to `"none"`
 * and every existing caller (RF-186's sweep, this file's own tests) is
 * byte-for-byte unaffected: pass neither field and the two columns land
 * exactly where they always did, `outcomeConfirmedBy: "none"` and
 * `recoveredCents` untouched (still `null` on a case that never set it).
 * E6's diff close is the other one: it *did* confirm an outcome, from
 * evidence a diff between two invoices produced, and when the news is good
 * it *did* recover real money - `confirmedBy: "diff"` is what tells the two
 * apart on `cases.outcome_confirmed_by` and in `outcome_confirmed`'s
 * payload, which is what RF-204's `confirmedRecoveredCents` (`metrics.ts`)
 * filters on.
 *
 * `recoveredCents` may only be passed alongside `confirmedBy: "diff"` - a
 * system close that confirmed nothing cannot also have recovered money, and
 * accepting the field anyway would let a caller write a number into §1.4's
 * north-star metric with no confirmation behind it at all. It must be a
 * non-negative integer (money is cents, never a float - see this package's
 * other close), and it must be `0` unless `outcome` is `resolved` or
 * `partial` - the identical cross-field rule
 * `apps/web/app/api/cases/[id]/close/route.ts` enforces on `closeCase`'s own
 * `recoveredCents`, restated here so a diff close and a person's own close
 * cannot disagree about what a `denied` or `abandoned` outcome is allowed to
 * claim it recovered. Every violation throws, exactly as `closeCase` throws
 * for the same reason: a bad argument is not a missing row. Defaults to
 * `0`, matching `closeCase`'s own default for the same field.
 *
 * **`stage_advanced`'s `by` stays `"system"` regardless of `confirmedBy`.**
 * `confirmedBy` says who vouches for the *outcome*; `by` says who moved the
 * *stage*, and both closes here move it without a session behind them.
 *
 * **`at`** overrides the instant everything this writes is stamped with —
 * `closed_at`, `stage_entered_at`, the settled findings' `updated_at` and
 * both events' `occurred_at`. Added by E5 Task 3, whose sweeper carries an
 * injected clock because RF-186's acceptance is a *simulação temporal*: a
 * `closedAt` on the wall clock while the rest of the run counted from a
 * simulated instant would make the acceptance test lie about what it proved.
 * Defaults to `new Date()`, so no existing caller changes.
 *
 * **`reason`**, threaded into `stage_advanced`'s payload beside
 * `{ from, to, by, outcome }`. There is more than one way for a case to end
 * up `abandoned` — the person went quiet without the case ever stalling, and
 * RF-186's stall window running out — and the two must stay tellable apart
 * from `events` alone, because RF-187's dossier is a document a judge reads
 * and "nobody replied to us" and "we never wrote to them" are not the same
 * account of what happened. Omitted, the payload is byte-identical to before.
 */
export async function closeCaseAsSystem(
  db: Db,
  caseId: string,
  input: {
    outcome: CaseOutcome;
    confirmedBy?: "none" | "diff";
    recoveredCents?: number;
    note?: string;
    at?: Date;
    reason?: string;
  },
) {
  const confirmedBy = input.confirmedBy ?? "none";
  if (input.recoveredCents !== undefined && confirmedBy !== "diff") {
    throw new Error(
      `closeCaseAsSystem: recoveredCents may only be passed with confirmedBy: "diff", got confirmedBy: "${confirmedBy}"`,
    );
  }
  const recoveredCents = input.recoveredCents ?? 0;
  if (!Number.isInteger(recoveredCents) || recoveredCents < 0) {
    throw new Error(`closeCaseAsSystem: recoveredCents must be a non-negative integer of cents, got ${input.recoveredCents}`);
  }
  const favourable = input.outcome === "resolved" || input.outcome === "partial";
  if (recoveredCents > 0 && !favourable) {
    throw new Error(
      `closeCaseAsSystem: recoveredCents must be 0 for outcome "${input.outcome}", got ${recoveredCents}`,
    );
  }
  const now = input.at ?? new Date();
  return db.transaction(async (tx) => {
    // Read under `FOR UPDATE` for `stage_advanced`'s `from` only — Postgres
    // before 18 cannot return a column's pre-UPDATE value, and the stage the
    // case is leaving is what the close destroys. Locking `cases` before
    // `findings` matches the order `closeCase` and the protocol/advance
    // writes take, so two paths cannot deadlock against each other.
    const [before] = await tx.select({ stage: cases.stage })
      .from(cases)
      .where(eq(cases.id, caseId))
      .for("update");
    const [updated] = await tx.update(cases)
      .set({
        stage: "closed",
        stageEnteredAt: now,
        outcome: input.outcome,
        outcomeConfirmedBy: confirmedBy,
        // Only written for a diff close. Left out of the `.set()` entirely
        // for `confirmedBy: "none"` rather than written as a defaulted `0`,
        // so RF-186's sweep keeps its exact original behaviour: a case that
        // never set `recoveredCents` stays `null`, not `0` - the two mean
        // different things (no money was ever confirmed vs. a confirmed
        // zero), and `apps/jobs/test/case-deadlines.test.ts` asserts the
        // column stays `null` after an abandonment close.
        ...(confirmedBy === "diff" ? { recoveredCents } : {}),
        closedAt: now,
        nextDeadlineAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(cases.id, caseId),
        isNull(cases.closedAt),
        ne(cases.stage, "closed"),
      ))
      .returning();
    if (!updated) return null;

    await settleCaseFindings(tx, {
      findingIds: updated.findingIds,
      outcome: input.outcome,
      at: now,
    });

    await tx.insert(events).values({
      id: newId("evt"),
      userId: updated.userId,
      invoiceId: updated.invoiceId,
      caseId: updated.id,
      type: "outcome_confirmed" satisfies EventType,
      occurredAt: now,
      payload: {
        outcome: updated.outcome,
        recoveredCents: updated.recoveredCents,
        confirmedBy,
        ...(input.note === undefined ? {} : { note: maskText(input.note) }),
      },
    });
    await tx.insert(events).values({
      id: newId("evt"),
      userId: updated.userId,
      invoiceId: updated.invoiceId,
      caseId: updated.id,
      type: "stage_advanced" satisfies EventType,
      occurredAt: now,
      payload: {
        from: before?.stage ?? null, to: "closed", by: "system", outcome: updated.outcome,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    });
    return updated;
  });
}
