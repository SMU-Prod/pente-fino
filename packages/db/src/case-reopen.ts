import { and, eq, isNotNull } from "drizzle-orm";
import { newId, type EventType, type Stage } from "@pentefino/core";
import { getUnscopedDb } from "./client.js";
import { reopenCaseFindings } from "./case-close.js";
import { cases, events } from "./schema.js";

type Db = ReturnType<typeof getUnscopedDb>;

/**
 * RF-203's write half: "reabertura automática se o item voltar na fatura
 * N+2, com histórico carimbado". Task 4's job decides *when* this runs (a
 * diff between invoice N+1 and N+2 finding the disputed charge back); this
 * function is only the write, exactly the shape `closeCaseAsSystem`
 * (`./case-close.ts`) is for the opposite transition - no session, a case id
 * the caller already read out of `cases`, one transaction.
 *
 * **One-shot, the same way `closeCaseAsSystem` is, and for the same
 * reason.** The UPDATE's predicate folds in `closed_at IS NOT NULL` and
 * `stage = 'closed'`, so a job that runs twice over the same case (a retry,
 * two workers) reopens it once and returns `null` the second time rather
 * than emitting a second `case_reopened` on a case that already moved on.
 * There is no `FOR UPDATE` read here the way `closeCaseAsSystem` needs one:
 * that read exists only to learn the stage a case is *leaving*, which
 * Postgres before 18 cannot return from an UPDATE - but the stage a reopen
 * leaves is always `closed` by construction of this same predicate, so
 * `from: "closed"` is a literal, not a value that needs locking to observe.
 *
 * **`stage` must not be `"closed"`.** Reopening a case straight back into
 * the state this function requires it to already be leaving is a
 * contradiction, and worse than a no-op: it would satisfy the one-shot
 * predicate, write real events, and leave the case permanently unreachable
 * by any later attempt at the *actual* reopen this call was supposed to be.
 * Rejected before the transaction even opens, by throwing - a bad argument
 * is not a missing row, the same distinction `closeCaseAsSystem` and
 * `closeCase` both draw for their own `recoveredCents`.
 *
 * **`recoveredCents` is reset to `0`, and this is the single most important
 * line in this function.** The charge that a closed case's outcome said was
 * fixed has come back, so whatever this case reported as recovered was never
 * actually recovered - reality has reversed the confirmation
 * `closeCaseAsSystem`'s diff close made. §1.4's north-star metric
 * (`metrics.ts`'s `confirmedRecoveredCents`) sums `cases.recovered_cents`
 * directly, and a reopened case that kept its old figure would leave that
 * sum permanently counting money that was confirmed and then un-confirmed -
 * with no later read able to tell that apart from a genuine recovery, since
 * both are just an integer sitting in the same column. Resetting it here,
 * in the same write that clears `outcome` and `outcomeConfirmedBy`, is what
 * keeps the column meaning "confirmed as of right now" rather than "the last
 * number anyone wrote".
 *
 * **`outcome`, `outcomeConfirmedBy` and `nextDeadlineAt` are cleared to
 * `null`.** A reopened case has reached no outcome yet (it is back in
 * `stage`, mid-dispute again) and confirms nothing (whatever confirmed the
 * old, now-reversed outcome says nothing about this new round); a fresh
 * deadline for the reopened stage is Task 4's job's concern (mirroring how
 * `createCase` alone decides a brand-new case's first deadline), not this
 * write's - stamping one here would be a guess this function has no basis
 * for.
 *
 * **The findings.** `reopenCaseFindings` (`./case-close.ts`, beside
 * `settleCaseFindings` it mirrors) moves this case's findings from
 * `resolved` back to `contested`, and only those - a finding already
 * `unresolved` needed no undoing (it never stopped reading as live), and one
 * the person has since dismissed keeps the status they chose. See that
 * function's own doc comment for why the missing invariant-race
 * `with-user.ts`'s `CONTESTABLE_FINDING_STATUSES` comment warns about for
 * `case_reopened` does not apply here.
 *
 * **Two events, at `at`, in the one transaction.** `case_reopened` is E6's
 * own name for this transition (already in `EVENTS`, `packages/core/src/
 * events.ts`), carrying `{ from: "closed", to: stage, by: "system" }` plus
 * whatever `reason`/`evidence` the caller hands in - RF-203's "histórico
 * carimbado" is exactly this event, not a comment left for a future reader.
 * `stage_advanced` is written beside it in the identical `{ from, to, by }`
 * shape `closeCaseAsSystem` writes for the opposite transition, so a
 * consumer walking `stage_advanced` rows for a case's history (RF-187's
 * dossier, `next-stage.table.ts`'s instruction to recover a case's pre-close
 * stage from "the last `stage_advanced`") reads one shape for every stage
 * change this system ever makes, not two.
 *
 * **Neither `reason` nor `evidence` is masked through `maskText`, unlike
 * `closeCaseAsSystem`'s `note`.** That is not an omission - it mirrors
 * `closeCaseAsSystem` exactly, which also never masks its own `reason`
 * field. Both are values a job supplies from a fixed vocabulary (Task 4's
 * job passes `reason: "item_reappeared"`, mirroring `STAGE_EVENT_TYPES`'
 * own member of that name; `evidence` is `{ invoiceId, findingIds }`, not
 * prose), never free text a person typed - `note` is masked because it is
 * the one field in this file's sibling that *can* carry a CPF. If a future
 * caller ever needs to pass genuinely free text here, it needs its own
 * `maskText` call and its own name, the same way `closeCase`'s `note` has
 * one and `closeCaseAsSystem`'s `reason` deliberately does not.
 *
 * `userId`/`invoiceId` on both events come from the row the UPDATE itself
 * returned, the same pattern `closeCaseAsSystem` uses - no second read is
 * needed to know who a case belongs to once the write that touched it has
 * already told us.
 */
export async function reopenCase(
  db: Db,
  caseId: string,
  input: { stage: Stage; at?: Date; reason?: string; evidence?: Record<string, unknown> },
): Promise<typeof cases.$inferSelect | null> {
  if (input.stage === "closed") {
    throw new Error("reopenCase: stage must not be \"closed\" - reopening into closed is a contradiction");
  }
  const now = input.at ?? new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(cases)
      .set({
        stage: input.stage,
        stageEnteredAt: now,
        closedAt: null,
        outcome: null,
        outcomeConfirmedBy: null,
        nextDeadlineAt: null,
        // See this function's own doc comment: the money this case reported
        // as recovered was never actually recovered, now that the charge
        // that outcome was about has come back.
        recoveredCents: 0,
        updatedAt: now,
      })
      .where(and(
        eq(cases.id, caseId),
        isNotNull(cases.closedAt),
        eq(cases.stage, "closed"),
      ))
      .returning();
    if (!updated) return null;

    await reopenCaseFindings(tx, { findingIds: updated.findingIds, at: now });

    await tx.insert(events).values({
      id: newId("evt"),
      userId: updated.userId,
      invoiceId: updated.invoiceId,
      caseId: updated.id,
      type: "case_reopened" satisfies EventType,
      occurredAt: now,
      payload: {
        from: "closed", to: input.stage, by: "system",
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      },
    });
    await tx.insert(events).values({
      id: newId("evt"),
      userId: updated.userId,
      invoiceId: updated.invoiceId,
      caseId: updated.id,
      type: "stage_advanced" satisfies EventType,
      occurredAt: now,
      payload: { from: "closed", to: input.stage, by: "system" },
    });
    return updated;
  });
}
