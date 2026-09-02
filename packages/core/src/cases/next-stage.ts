import type { Category } from "../invoice/canonical.js";
import type { Playbook, Stage } from "./playbook.js";
import { STAGE_EVENT_TYPES, decideTransition, type DeadlineRule } from "./next-stage.table.js";

// The event vocabulary is declared beside the table that validates against
// it (`next-stage.table.ts`), so the two cannot drift, and re-exported here
// because `StageEvent` is what the rest of the system imports.
export { STAGE_EVENT_TYPES };

export type StageEvent = {
  type: (typeof STAGE_EVENT_TYPES)[number];
  at: Date;
};

// Sibling of `cases.stage` (§9.1's `closed{outcome:abandoned}`). Mirrors
// the `cases.outcome` column: resolved | partial | denied | abandoned.
export const CASE_OUTCOMES = ["resolved", "partial", "denied", "abandoned"] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];

export type StageTransition = {
  stage: Stage;
  nextDeadlineAt: Date | null;
  stampDeadline: boolean;
  // RF-186: null unless this transition closes the case, in which case it
  // says why (e.g. `abandoned` after 60 days without user action).
  outcome: CaseOutcome | null;
};

/**
 * MERGE POINT — E5 Task 1 (`packages/core/src/cases/deadline.ts`).
 *
 * Turning a `DeadlineRule` into an instant needs the Brazilian national
 * holiday calendar and the business-day arithmetic Task 1 owns. That task
 * built in parallel on its own branch, so this function is deliberately the
 * only thing in the transition that is not finished: it answers `null`
 * rather than guessing a date, and `next-stage.test.ts` carries a tripwire
 * test named for this merge so the gap cannot ship unnoticed.
 *
 * Task 1's branch (`e5-task-1-deadline-calendar`) ships:
 *
 * ```ts
 * export type DeadlineInput = { startedAt: Date; days: number; businessDays: boolean };
 * export type Deadline = { startDate: CivilDate; deadlineDate: CivilDate; expiresAt: Date };
 * export function computeDeadline(input: DeadlineInput): Deadline;
 * ```
 *
 * so the merge is: import it and replace this body with
 *
 * ```ts
 * return computeDeadline({
 *   startedAt: from, days: rule.days, businessDays: rule.businessDays,
 * }).expiresAt;
 * ```
 *
 * `from` is `event.at`, the instant the wait starts. `computeDeadline`
 * throws for a negative or fractional `days`; `responseWait` already returns
 * `clear` rather than a wait for `responseDays <= 0`, so no rule that
 * reaches here carries one.
 *
 * `Deadline.deadlineDate` is worth carrying further than this function
 * eventually: RF-182's document has to print the date, and re-deriving it
 * from the instant in another timezone is the bug Task 1's third decision
 * exists to avoid. `StageTransition` has no field for it, so that belongs to
 * whoever builds RF-182 (Task 5), not here.
 */
function deadlineInstant(rule: DeadlineRule, from: Date): Date | null {
  if (rule.kind !== "wait") return null;
  void from;
  return null;
}

/**
 * Pure transition of the case state machine (§9.1).
 *
 * Total over `stage × event × category × hasProtocol`: every combination has
 * a mapped answer, and `next-stage.test.ts` enumerates the whole product to
 * prove it. `next-stage.table.ts` holds the table and the reasoning behind
 * each branch.
 *
 * `stampDeadline` says whether the caller must write `nextDeadlineAt` to
 * `cases.next_deadline_at`; `false` means leave the column exactly as it is.
 * A `stampDeadline: true` with a null `nextDeadlineAt` clears the column,
 * and is only ever returned for a transition that genuinely has nothing
 * pending on a clock — a closed case, or a channel that has answered.
 */
export function nextStage(
  current: { stage: Stage; category: Category; hasProtocol: boolean },
  playbook: Playbook,
  event: StageEvent,
): StageTransition {
  const decision = decideTransition(current, playbook, event);
  const nextDeadlineAt = deadlineInstant(decision.deadline, event.at);
  return {
    stage: decision.stage,
    outcome: decision.outcome,
    // A wait whose instant could not be computed must read as "leave the
    // column alone", never as "clear it". Clearing drops the case out of the
    // `cases_next_deadline` partial index and it is never scanned again —
    // silently, and indistinguishably from a case that finished. Until the
    // merge point above is wired, every `wait` is such a case.
    //
    // This is not a temporary expression: once `deadlineInstant` returns a
    // date for every `wait`, it reduces to `kind !== "keep"` on its own.
    stampDeadline: decision.deadline.kind === "clear"
      || (decision.deadline.kind === "wait" && nextDeadlineAt !== null),
    nextDeadlineAt,
  };
}
