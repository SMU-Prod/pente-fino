import type { Category } from "../invoice/canonical.js";
import type { Playbook, Stage } from "./playbook.js";

export type StageEvent = {
  type:
    | "protocol_entered"
    | "deadline_expired"
    | "response_received"
    | "resolved"
    | "user_abandon"
    // RF-203: the contested item comes back on invoice N+2. Reopens a
    // closed case, with the reopening stamped into its history.
    | "item_reappeared";
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
 * Pure transition of the case state machine (§9.1).
 *
 * E0 ships the signature. The full decision table — every combination of
 * stage × event × category — arrives in E5, with the test that covers all
 * of them. Until then an unmapped combination throws, because a wrong stage
 * would silently lose someone's case.
 */
export function nextStage(
  current: { stage: Stage; category: Category; hasProtocol: boolean },
  playbook: Playbook,
  event: StageEvent,
): StageTransition {
  void playbook;
  throw new Error(
    `transition not mapped: stage=${current.stage} event=${event.type} category=${current.category} hasProtocol=${current.hasProtocol} (E5)`,
  );
}
