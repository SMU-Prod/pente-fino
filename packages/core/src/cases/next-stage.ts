import type { Category } from "../invoice/canonical.js";
import type { Playbook, Stage } from "./playbook.js";
import { computeDeadline } from "./deadline.js";
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
 * The instant a `wait` rule ends, via E5 Task 1's calendar (RF-181).
 *
 * `from` is `event.at`, the instant the wait starts. `computeDeadline`
 * throws a `RangeError` for a negative or fractional `days`;
 * `next-stage.table.ts`'s `responseWait` already answers `clear` rather than
 * a wait for `responseDays <= 0`, so no rule reaching here carries one.
 *
 * `computeDeadline` also returns `deadlineDate`, the São Paulo civil date
 * the deadline falls on. `StageTransition` has no field for it, so RF-182's
 * document — which has to print that date — should call `computeDeadline`
 * itself rather than re-deriving the date from `expiresAt` in some other
 * timezone, which is the off-by-a-day bug that module's third decision
 * exists to prevent.
 */
function deadlineInstant(rule: DeadlineRule, from: Date): Date | null {
  if (rule.kind !== "wait") return null;
  return computeDeadline({
    startedAt: from,
    days: rule.days,
    businessDays: rule.businessDays,
  }).expiresAt;
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
  return {
    stage: decision.stage,
    outcome: decision.outcome,
    stampDeadline: decision.deadline.kind !== "keep",
    nextDeadlineAt: deadlineInstant(decision.deadline, event.at),
  };
}
