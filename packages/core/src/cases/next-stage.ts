import type { Category } from "../invoice/canonical.js";
import type { Playbook, Stage } from "./playbook.js";

export type StageEvent = {
  type: "protocol_entered" | "deadline_expired" | "response_received" | "resolved" | "user_abandon";
  at: Date;
};

export type StageTransition = {
  stage: Stage;
  nextDeadlineAt: Date | null;
  stampDeadline: boolean;
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
    `transition not mapped: stage=${current.stage} event=${event.type} category=${current.category} (E5)`,
  );
}
