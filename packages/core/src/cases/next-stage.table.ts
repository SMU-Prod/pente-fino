import { CATEGORIES, type Category } from "../invoice/canonical.js";
import { STAGES, type Playbook, type Stage } from "./playbook.js";
// Types only, deliberately: `next-stage.ts` imports `decideTransition` from
// here, and `verbatimModuleSyntax` erases a type-only import entirely, so
// the two files do not form a module cycle at runtime.
import type { CaseOutcome, StageEvent } from "./next-stage.js";

/**
 * PRD §9.1's decision table, as data plus the three rules that read it.
 *
 * ```
 * draft ──(usuário cria contestação)──▶ sac
 *   sac ──(protocolo colado)──▶ [espera responseDays]
 *       ├─(resolvido pelo diff ou usuário)──▶ closed
 *       ├─(prazo vencido)──▶ ombudsman (só card) ou consumidor_gov
 *       └─(30d sem protocolo)──▶ stalled (sub-estado, volta a sac)
 *   ombudsman ──▶ consumidor_gov
 *   consumidor_gov ──▶ regulator
 *   regulator ──▶ procon (opcional) ──▶ jec_ready
 *   jec_ready ──▶ closed
 *   qualquer ──(60d sem ação do usuário)──▶ closed{outcome:abandoned}
 * ```
 *
 * The decision is split out of `nextStage` for one reason: the deadline a
 * transition asks for is a *rule* (how many days, counted how, from where
 * it came), while `StageTransition.nextDeadlineAt` is an *instant*. Turning
 * the rule into an instant needs the Brazilian business-day calendar, which
 * is E5 Task 1's `./deadline.js`. Keeping the rule addressable means the
 * whole table can be tested today, exhaustively, without that calendar —
 * and the merge is one expression in `nextStage`.
 *
 * Three §9.1 readings this file commits to, because the diagram leaves them
 * implicit and a wrong guess loses somebody's case:
 *
 *  1. **`hasProtocol` is per-stage, not per-case.** It answers "has the
 *     user pasted the protocol number for the channel the case is sitting
 *     in". That is what makes it the discriminator §9.1 needs: an expired
 *     deadline *with* a protocol is the channel staying silent (escalate),
 *     an expired deadline *without* one is the user not having written to
 *     the channel at all (RF-186's stall). `case_protocols.stage` records
 *     protocols per stage, so the caller can answer this.
 *  2. **Which clock is running follows from `hasProtocol` too.** A stage
 *     entered without a protocol waits on RF-186's 30-day protocol window;
 *     once the protocol is in, it waits on the playbook's `responseDays`.
 *     §9.1 draws exactly this: `sac ──(protocolo colado)──▶ [espera
 *     responseDays]`. An escalation therefore always lands on the 30-day
 *     window, because the new channel has no protocol yet.
 *  3. **`stalled` is not a stage.** §9.1 calls it a *sub-estado* that
 *     "volta a sac", `STAGES` does not contain it and the
 *     `cases_stage_values` CHECK constraint rejects it. It is represented
 *     here as what it is: a return to `sac` with the protocol window
 *     restarted. A caller identifies it as the `deadline_expired`
 *     transition whose `hasProtocol` was false, and records it in `events`
 *     (A3) rather than in `cases.stage`.
 */

/**
 * RF-186: "Caso sem protocolo por 30 dias entra em `stalled`". The same 30
 * days is the second window, after which RF-186 closes the case as
 * `abandoned` — §9.1's "60d sem ação do usuário", the two windows back to
 * back.
 *
 * Calendar days, not business days: RF-186 counts a person's silence, and a
 * person is silent on Sundays too. The playbook's `businessDays` flag exists
 * for the deadlines a *company* is answering under.
 */
export const PROTOCOL_WINDOW_DAYS = 30;

/**
 * What a transition wants done with `cases.next_deadline_at`.
 *
 *  - `keep` — do not touch the column. The transition changed nothing that
 *    a clock was measuring.
 *  - `clear` — write null. Nothing is pending: the case closed, or the
 *    channel answered and the next move is the user's.
 *  - `wait` — start a new wait of `days`, counted as `businessDays` says.
 *    `source` records which requirement the number came from, so a wrong
 *    deadline can be traced back to the playbook row or to RF-186 without
 *    re-deriving the table.
 */
export type DeadlineRule =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "wait"; days: number; businessDays: boolean; source: "playbook" | "protocol_window" };

/** One row of §9.1's table, before the deadline rule becomes an instant. */
export type StageDecision = {
  stage: Stage;
  outcome: CaseOutcome | null;
  deadline: DeadlineRule;
};

export type CaseState = {
  stage: Stage;
  category: Category;
  hasProtocol: boolean;
};

const KEEP: DeadlineRule = { kind: "keep" };
const CLEAR: DeadlineRule = { kind: "clear" };

/**
 * RF-186's window. Applies whenever a case sits in a channel it has not yet
 * written to — a freshly created case, a stage just escalated into, and the
 * stall itself.
 */
const PROTOCOL_WINDOW: DeadlineRule = {
  kind: "wait",
  days: PROTOCOL_WINDOW_DAYS,
  businessDays: false,
  source: "protocol_window",
};

function playbookEntry(playbook: Playbook, stage: Stage): Playbook["stages"][number] | undefined {
  return playbook.stages.find((entry) => entry.stage === stage);
}

/**
 * The wait a channel owes an answer in, from the issuer's playbook (RF-181).
 *
 * Two ways this comes back as `clear` rather than a wait, both meaning "this
 * stage has no clock", never "invent one":
 *
 *  - **The playbook does not declare the stage.** §20.2's telecom playbook
 *    has no `ombudsman` and no `procon`, though §9.1 routes to both. There
 *    is no `responseDays` to count, and a guessed one would tell the person
 *    to escalate on a date with no basis behind it.
 *  - **`responseDays` is 0.** §20.2 gives `jec_ready` exactly that: filing
 *    with a small-claims court is not a wait this product measures, and a
 *    zero-day wait would expire the instant it was stamped.
 */
function responseWait(playbook: Playbook, stage: Stage): DeadlineRule {
  const entry = playbookEntry(playbook, stage);
  if (entry === undefined || entry.responseDays <= 0) return CLEAR;
  return {
    kind: "wait",
    days: entry.responseDays,
    businessDays: entry.businessDays,
    source: "playbook",
  };
}

/**
 * §9.1's escalation chain: the channel a case moves to when the one it is in
 * lets its deadline pass.
 *
 * Two edges are conditional, and they are the two §9.1 marks as such:
 *
 *  - **`ombudsman` only for `card`.** Card issuers have a regulated
 *    ouvidoria that telecom, energy and water complaints do not route
 *    through; those three go straight to consumidor.gov.br.
 *  - **`procon` is optional**, and the playbook is what decides. An
 *    "optional" stage in a playbook-driven machine is one the issuer's
 *    playbook either declares or does not — §20.2 does not, so a telecom
 *    case goes `regulator → jec_ready`.
 *
 * Every other edge is unconditional. A stage the playbook happens not to
 * declare is still routed to, because §9.1's graph is the requirement and
 * the playbook only supplies the channel's text and its deadline; skipping
 * ahead on missing configuration would push somebody towards small-claims
 * court because an ops row was never filled in.
 *
 * `null` means there is nothing after this stage to escalate to.
 */
function escalationTarget(stage: Stage, category: Category, playbook: Playbook): Stage | null {
  switch (stage) {
    // §9.1's only edge out of `draft` is to `sac`. A draft whose clock ran
    // out has not stopped needing a SAC protocol, so that is where it goes.
    case "draft": return "sac";
    case "sac": return category === "card" ? "ombudsman" : "consumidor_gov";
    case "ombudsman": return "consumidor_gov";
    case "consumidor_gov": return "regulator";
    case "regulator": return playbookEntry(playbook, "procon") === undefined ? "jec_ready" : "procon";
    case "procon": return "jec_ready";
    // `jec_ready` is the end of the escalation ladder: what follows it is a
    // court, not another channel this machine drives. `closed` never
    // reaches here — `decideTransition` answers for it first.
    case "jec_ready": case "closed": return null;
  }
}

function closeWith(outcome: CaseOutcome): StageDecision {
  return { stage: "closed", outcome, deadline: CLEAR };
}

/**
 * The E0 contract, kept: a combination this table does not map throws rather
 * than guessing, because a wrong stage silently loses somebody's case.
 *
 * After E5 every combination of the declared `stage × event × category ×
 * hasProtocol` *is* mapped — `next-stage.test.ts` enumerates the product to
 * prove it. What still reaches this error is a value from outside those
 * declarations: a `cases.stage` written by an older deploy, an event name
 * from a queue message that no longer matches, a category added to
 * `CATEGORIES` without a row being added here. TypeScript cannot see any of
 * those, so the check is at runtime.
 */
function unmapped(current: CaseState, event: StageEvent): Error {
  return new Error(
    `transition not mapped: stage=${current.stage} event=${event.type} `
    + `category=${current.category} hasProtocol=${current.hasProtocol}`,
  );
}

/**
 * §9.1's transition, as stage + outcome + the deadline rule that follows.
 * Total over `stage × event × category × hasProtocol` — every combination
 * has an answer, and `next-stage.test.ts` enumerates all of them.
 */
export function decideTransition(
  current: CaseState,
  playbook: Playbook,
  event: StageEvent,
): StageDecision {
  if (!STAGES.includes(current.stage) || !CATEGORIES.includes(current.category)) {
    throw unmapped(current, event);
  }

  // `closed` is terminal. RF-203's `item_reappeared` is the single way out:
  // the contested item came back on invoice N+2, so there is a fresh charge
  // and the case restarts at the first channel, needing a new protocol.
  //
  // Everything else is a no-op that deliberately leaves `outcome` null.
  // `outcome` on a transition means "this transition closed the case, and
  // this is why"; a second `resolved` on an already-closed case closed
  // nothing, and returning `resolved` here would let a late event overwrite
  // the outcome the case actually reached.
  //
  // E6 owns RF-203's full semantics (`case_reopened`, clearing
  // `cases.outcome` and `closed_at`); this row exists so the table is total.
  if (current.stage === "closed") {
    return event.type === "item_reappeared"
      ? { stage: "sac", outcome: null, deadline: PROTOCOL_WINDOW }
      : { stage: "closed", outcome: null, deadline: KEEP };
  }

  switch (event.type) {
    // §9.1: "resolvido pelo diff ou usuário ──▶ closed".
    case "resolved":
      return closeWith("resolved");

    // §9.1: "qualquer ──(60d sem ação do usuário)──▶ closed{outcome:abandoned}",
    // and the user saying so outright. Both arrive as this event: the pure
    // function is not given the case's age, so the caller that *does* know
    // it — E5 Task 3's deadline job — is the one that decides 60 days of
    // silence means abandonment and emits this rather than another
    // `deadline_expired`. Without that, a case with no protocol would stall
    // back to `sac` forever.
    case "user_abandon":
      return closeWith("abandoned");

    // The case is already open; there is nothing to reopen. The
    // reappearance is evidence for the case being worked, not a transition.
    case "item_reappeared":
      return { stage: current.stage, outcome: null, deadline: KEEP };

    // The channel answered. The wait existed to detect silence, so it is
    // over — escalating afterwards on a clock that already got its answer
    // would escalate on a false premise. The stage does not move: the user
    // reads the answer and either marks the case resolved or escalates.
    case "response_received":
      return { stage: current.stage, outcome: null, deadline: CLEAR };

    // §9.1: "sac ──(protocolo colado)──▶ [espera responseDays]". The stage
    // does not move — the wait starts. From `draft` it also completes
    // §9.1's "usuário cria contestação" edge, because a protocol number is
    // a channel having been written to.
    case "protocol_entered": {
      const stage: Stage = current.stage === "draft" ? "sac" : current.stage;
      return { stage, outcome: null, deadline: responseWait(playbook, stage) };
    }

    case "deadline_expired": {
      const target = escalationTarget(current.stage, current.category, playbook);
      // `jec_ready`: nothing after it, and §20.2 gives it no wait to expire
      // in the first place. Falling through to the stall below would march
      // a case that is ready for court back to the SAC.
      if (target === null) {
        return { stage: current.stage, outcome: null, deadline: CLEAR };
      }
      // §9.1's `stalled` sub-state: "30d sem protocolo ──▶ stalled
      // (sub-estado, volta a sac)". No protocol means the person never
      // wrote to the channel, so there is no company silence to escalate
      // against — and every channel past `sac` needs the previous
      // protocol to file at all (§20.2's `requiresPreviousProtocol`).
      if (!current.hasProtocol) {
        return { stage: "sac", outcome: null, deadline: PROTOCOL_WINDOW };
      }
      // The channel stayed silent past its own deadline. Escalate — and the
      // channel being escalated into has no protocol yet, so RF-186's
      // window is what runs there, not the new stage's `responseDays`.
      return { stage: target, outcome: null, deadline: PROTOCOL_WINDOW };
    }

    default:
      throw unmapped(current, event);
  }
}
