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
 * Closes a case with no user session behind it — RF-186's day-60
 * abandonment, and any later system close.
 *
 * Deliberately **not** a `withUser` method: there is no session to scope it
 * to, and INV-008 is about a *user's* query reaching another user's data.
 * The case id here comes from a scan this package's own job ran, never from
 * a request body, so there is no ownership to prove and nothing to leak — a
 * caller cannot pass an id it did not first read out of `cases`.
 *
 * Everything `closeCase` does, minus the parts that only make sense for a
 * person: no `recoveredCents` (a system close recovered nothing by
 * definition — RF-186's `abandoned` is nobody coming back, not a refund),
 * and `outcomeConfirmedBy: "none"`, which is the §6.2 value for "no one
 * confirmed this" as opposed to `user` or `diff`.
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
 */
export async function closeCaseAsSystem(
  db: Db,
  caseId: string,
  input: { outcome: CaseOutcome; note?: string },
) {
  const now = new Date();
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
        outcomeConfirmedBy: "none",
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
      payload: {
        outcome: updated.outcome,
        recoveredCents: updated.recoveredCents,
        confirmedBy: "none",
        ...(input.note === undefined ? {} : { note: maskText(input.note) }),
      },
    });
    await tx.insert(events).values({
      id: newId("evt"),
      userId: updated.userId,
      invoiceId: updated.invoiceId,
      caseId: updated.id,
      type: "stage_advanced" satisfies EventType,
      payload: { from: before?.stage ?? null, to: "closed", by: "system", outcome: updated.outcome },
    });
    return updated;
  });
}
