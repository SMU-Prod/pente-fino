import type { Category } from "../invoice/canonical.js";
import type { Playbook, Stage } from "./playbook.js";
import { decideTransition, type DeadlineRule } from "./next-stage.table.js";

/**
 * The events §9.1's machine answers to.
 *
 * A runtime list rather than a bare union, so the test that §9.1 demands —
 * "todas as combinações `stage × event × category`" — can enumerate the
 * product instead of restating it by hand. A hand-written list in the test
 * would silently stop covering a seventh event the day one is added; this
 * one cannot.
 */
export const STAGE_EVENT_TYPES = [
  "protocol_entered",
  "deadline_expired",
  "response_received",
  "resolved",
  "user_abandon",
  // RF-203: the contested item comes back on invoice N+2. Reopens a
  // closed case, with the reopening stamped into its history.
  "item_reappeared",
] as const;

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
 * holiday calendar and the business-day arithmetic Task 1 owns. That task is
 * building in parallel on its own branch, so this function is deliberately
 * the only thing in the transition that is not finished: it answers `null`
 * rather than guessing a date, and `next-stage.test.ts` carries a tripwire
 * test named for this merge so the gap cannot ship unnoticed.
 *
 * The interface assumed of Task 1, so the merge is one line:
 *
 * ```ts
 * import { addDeadline } from "./deadline.js";
 * declare function addDeadline(
 *   from: Date,
 *   days: number,
 *   options: { businessDays: boolean },
 * ): Date;
 * ```
 *
 * — `from` is `event.at`, the instant the wait starts; `days` and
 * `businessDays` come straight off the rule. Whatever Task 1 named it, the
 * body below becomes `addDeadline(from, rule.days, { businessDays:
 * rule.businessDays })` and this comment goes away.
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
 * A `stampDeadline: true` with a null `nextDeadlineAt` clears the column —
 * the case has nothing pending on a clock.
 */
export function nextStage(
  current: { stage: Stage; category: Category; hasProtocol: boolean },
  playbook: Playbook,
  event: StageEvent,
): StageTransition {
  const decision = decideTransition(current, playbook, event);
  return {
    stage: decision.stage,
    outcome: decision.outcome,
    stampDeadline: decision.deadline.kind !== "keep",
    nextDeadlineAt: deadlineInstant(decision.deadline, event.at),
  };
}
