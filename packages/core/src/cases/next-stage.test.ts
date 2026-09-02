import { describe, expect, it } from "vitest";
import { CATEGORIES, type Category } from "../invoice/canonical.js";
import { STAGES, type Playbook, type Stage } from "./playbook.js";
import { TELECOM_PLAYBOOK_V1 } from "./telecom-playbook.js";
import {
  CASE_OUTCOMES, STAGE_EVENT_TYPES, nextStage,
  type StageEvent, type StageTransition,
} from "./next-stage.js";
import { PROTOCOL_WINDOW_DAYS, decideTransition } from "./next-stage.table.js";

const AT = new Date("2026-08-30T14:00:00Z");

/** §20.2 declares no `procon` stage; §9.1 says the stage is optional. */
const PLAYBOOK_WITH_PROCON: Playbook = {
  stages: [
    ...TELECOM_PLAYBOOK_V1.stages,
    {
      stage: "procon",
      channel: "Procon",
      responseDays: 15,
      businessDays: true,
      requiresPreviousProtocol: true,
      asks: ["audiência de conciliação"],
      legalRefs: [],
    },
  ],
};

type Combination = {
  stage: Stage;
  category: Category;
  hasProtocol: boolean;
  event: StageEvent["type"];
};

/**
 * §9.1: "teste que cobre **todas** as combinações `stage × event ×
 * category`" — plus `hasProtocol`, which the same section makes an input of
 * `nextStage` and which decides §9.1's own `30d sem protocolo` branch.
 *
 * Built from the exported constants rather than written out, so adding a
 * ninth stage, a seventh event or a fifth category grows this enumeration on
 * its own instead of leaving the new value silently untested.
 */
const COMBINATIONS: Combination[] = STAGES.flatMap((stage) =>
  STAGE_EVENT_TYPES.flatMap((event) =>
    CATEGORIES.flatMap((category) =>
      [true, false].map((hasProtocol) => ({ stage, category, hasProtocol, event })),
    ),
  ),
);

// Most assertions below filter `COMBINATIONS` down to the offenders and
// expect an empty list, which an empty enumeration would satisfy for the
// wrong reason. The size is also asserted in the first test, but a `.only`
// run skips that one — this runs on import, so every test in the file is
// covered by it.
if (COMBINATIONS.length === 0) {
  throw new Error("the stage x event x category enumeration is empty: every invariant below is vacuous");
}

function transitionFor(combination: Combination, playbook = TELECOM_PLAYBOOK_V1): StageTransition {
  const { stage, category, hasProtocol, event } = combination;
  return nextStage({ stage, category, hasProtocol }, playbook, { type: event, at: AT });
}

function label(combination: Combination): string {
  return `${combination.stage} × ${combination.event} × ${combination.category}`
    + ` × hasProtocol=${combination.hasProtocol}`;
}

/**
 * §9.1's escalation ladder, in order. Used to assert that escalation only
 * ever moves forward along it — a table that sent `regulator` back to
 * `consumidor_gov` would still type-check and still return a real stage.
 */
const LADDER: Stage[] = [
  "draft", "sac", "ombudsman", "consumidor_gov", "regulator", "procon", "jec_ready",
];

function rank(stage: Stage): number {
  return LADDER.indexOf(stage);
}

describe("nextStage · the enumeration §9.1 requires", () => {
  it("enumerates every declared combination, and the enumeration is not empty", () => {
    expect(STAGES.length).toBeGreaterThan(0);
    expect(STAGE_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(CATEGORIES.length).toBeGreaterThan(0);
    expect(COMBINATIONS).toHaveLength(
      STAGES.length * STAGE_EVENT_TYPES.length * CATEGORIES.length * 2,
    );
    expect(new Set(COMBINATIONS.map(label)).size).toBe(COMBINATIONS.length);
  });

  it("maps every combination — none is left to throw", () => {
    const unmapped: string[] = [];
    for (const combination of COMBINATIONS) {
      try {
        transitionFor(combination);
      } catch (error) {
        unmapped.push(`${label(combination)}: ${(error as Error).message}`);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it("answers every combination with a declared stage and a declared outcome", () => {
    const offenders: string[] = [];
    for (const combination of COMBINATIONS) {
      const result = transitionFor(combination);
      const stageOk = (STAGES as readonly string[]).includes(result.stage);
      const outcomeOk = result.outcome === null
        || (CASE_OUTCOMES as readonly string[]).includes(result.outcome);
      if (!stageOk || !outcomeOk || typeof result.stampDeadline !== "boolean") {
        offenders.push(`${label(combination)} → ${JSON.stringify(result)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only ever reports an outcome on a transition that closes the case", () => {
    const offenders: string[] = [];
    for (const combination of COMBINATIONS) {
      const result = transitionFor(combination);
      if (result.outcome !== null && result.stage !== "closed") {
        offenders.push(`${label(combination)} → ${result.stage}/${result.outcome}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never sends a case back to `draft`, which only a new case starts in", () => {
    const offenders = COMBINATIONS
      .filter((combination) => combination.stage !== "draft")
      .filter((combination) => transitionFor(combination).stage === "draft")
      .map(label);
    expect(offenders).toEqual([]);
  });

  it("never produces §9.1's `stalled`, which is a sub-state and not a stage", () => {
    // `STAGES` has no `stalled` and the `cases_stage_values` CHECK
    // constraint rejects it, so a transition returning it would be a row
    // the database refuses to write.
    expect(STAGES as readonly string[]).not.toContain("stalled");
    const produced = new Set(COMBINATIONS.map((combination) => transitionFor(combination).stage));
    expect([...produced]).not.toContain("stalled");
  });

  // "Routes to" means entering the stage from somewhere else. A case already
  // sitting in `ombudsman` or `procon` stays there on the events that do not
  // move it, whatever its category, which is not what these two assert.
  const entering = (stage: Stage, playbook = TELECOM_PLAYBOOK_V1): Combination[] =>
    COMBINATIONS
      .filter((combination) => combination.stage !== stage)
      .filter((combination) => transitionFor(combination, playbook).stage === stage);

  it("routes to `ombudsman` only for `card` (§9.1)", () => {
    expect(entering("ombudsman").filter((c) => c.category !== "card").map(label)).toEqual([]);
    expect(entering("ombudsman").length).toBeGreaterThan(0);
  });

  it("routes to `procon` only when the playbook declares it (§9.1: opcional)", () => {
    expect(entering("procon").map(label)).toEqual([]);
    expect(entering("procon", PLAYBOOK_WITH_PROCON).length).toBeGreaterThan(0);
  });

  it("escalates only forward along §9.1's ladder, never back down it", () => {
    const offenders: string[] = [];
    for (const combination of COMBINATIONS) {
      if (combination.event !== "deadline_expired") continue;
      if (!combination.hasProtocol) continue; // the stall, asserted separately
      if (combination.stage === "closed") continue;
      const result = transitionFor(combination, PLAYBOOK_WITH_PROCON);
      const advanced = rank(result.stage) > rank(combination.stage);
      const terminal = combination.stage === "jec_ready" && result.stage === "jec_ready";
      if (!advanced && !terminal) offenders.push(`${label(combination)} → ${result.stage}`);
    }
    expect(offenders).toEqual([]);
  });

  it("closes as `resolved` from every open stage (§9.1)", () => {
    const offenders = COMBINATIONS
      .filter((combination) => combination.event === "resolved" && combination.stage !== "closed")
      .filter((combination) => {
        const result = transitionFor(combination);
        return result.stage !== "closed" || result.outcome !== "resolved";
      })
      .map(label);
    expect(offenders).toEqual([]);
  });

  it("closes as `abandoned` from every open stage (§9.1: qualquer → closed{abandoned})", () => {
    const offenders = COMBINATIONS
      .filter((combination) => combination.event === "user_abandon" && combination.stage !== "closed")
      .filter((combination) => {
        const result = transitionFor(combination);
        return result.stage !== "closed" || result.outcome !== "abandoned";
      })
      .map(label);
    expect(offenders).toEqual([]);
  });

  it("leaves a closed case closed, except for RF-203's reappearance", () => {
    const offenders = COMBINATIONS
      .filter((combination) => combination.stage === "closed")
      .filter((combination) => {
        const result = transitionFor(combination);
        return combination.event === "item_reappeared"
          ? result.stage !== "sac"
          : result.stage !== "closed" || result.outcome !== null || result.stampDeadline;
      })
      .map(label);
    expect(offenders).toEqual([]);
  });

  it("never asks the caller to clear a deadline the decision wanted to set", () => {
    // `stampDeadline: true` with a null date writes NULL to
    // `cases.next_deadline_at`, which drops the case out of the
    // `cases_next_deadline` partial index for good — silently, and
    // indistinguishably from a case that finished. That must only ever
    // happen where the decision genuinely says `clear`, never for a `wait`
    // whose instant came back missing.
    const offenders: string[] = [];
    for (const combination of COMBINATIONS) {
      const { stage, category, hasProtocol, event } = combination;
      const decision = decideTransition(
        { stage, category, hasProtocol }, TELECOM_PLAYBOOK_V1, { type: event, at: AT },
      );
      const result = transitionFor(combination);
      const clearing = result.stampDeadline && result.nextDeadlineAt === null;
      if (clearing && decision.deadline.kind !== "clear") {
        offenders.push(`${label(combination)} → ${decision.deadline.kind} cleared`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never touches the column at all for a decision that says `keep`", () => {
    const offenders: string[] = [];
    for (const combination of COMBINATIONS) {
      const { stage, category, hasProtocol, event } = combination;
      const decision = decideTransition(
        { stage, category, hasProtocol }, TELECOM_PLAYBOOK_V1, { type: event, at: AT },
      );
      if (decision.deadline.kind === "keep" && transitionFor(combination).stampDeadline) {
        offenders.push(label(combination));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("nextStage · the §9.1 branches that are easy to miss", () => {
  it("sends `sac` to `ombudsman` on an expired deadline, but only for `card`", () => {
    const result = nextStage(
      { stage: "sac", category: "card", hasProtocol: true },
      TELECOM_PLAYBOOK_V1,
      { type: "deadline_expired", at: AT },
    );
    expect(result.stage).toBe("ombudsman");
  });

  it("sends `sac` to `consumidor_gov` for every category that is not `card`", () => {
    for (const category of CATEGORIES.filter((c) => c !== "card")) {
      const result = nextStage(
        { stage: "sac", category, hasProtocol: true },
        TELECOM_PLAYBOOK_V1,
        { type: "deadline_expired", at: AT },
      );
      expect(result.stage, category).toBe("consumidor_gov");
    }
  });

  it("skips `procon` when the playbook does not declare it (§20.2 does not)", () => {
    const result = nextStage(
      { stage: "regulator", category: "telecom", hasProtocol: true },
      TELECOM_PLAYBOOK_V1,
      { type: "deadline_expired", at: AT },
    );
    expect(result.stage).toBe("jec_ready");
  });

  it("routes through `procon` when the playbook declares it", () => {
    const result = nextStage(
      { stage: "regulator", category: "telecom", hasProtocol: true },
      PLAYBOOK_WITH_PROCON,
      { type: "deadline_expired", at: AT },
    );
    expect(result.stage).toBe("procon");
  });

  it("walks the rest of §9.1's chain unconditionally", () => {
    const chain: Array<[Stage, Stage]> = [
      ["ombudsman", "consumidor_gov"],
      ["consumidor_gov", "regulator"],
      ["procon", "jec_ready"],
    ];
    for (const [from, to] of chain) {
      const result = nextStage(
        { stage: from, category: "telecom", hasProtocol: true },
        TELECOM_PLAYBOOK_V1,
        { type: "deadline_expired", at: AT },
      );
      expect(result.stage, from).toBe(to);
    }
  });

  it("returns a case with no protocol to `sac` — §9.1's `stalled`, restarting RF-186's window", () => {
    const decision = decideTransition(
      { stage: "consumidor_gov", category: "telecom", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "deadline_expired", at: AT },
    );
    expect(decision.stage).toBe("sac");
    expect(decision.outcome).toBeNull();
    expect(decision.deadline).toEqual({
      kind: "wait", days: PROTOCOL_WINDOW_DAYS, businessDays: false, source: "protocol_window",
    });
  });

  it("keeps a case that is ready for court at `jec_ready` rather than stalling it back to `sac`", () => {
    for (const hasProtocol of [true, false]) {
      const result = nextStage(
        { stage: "jec_ready", category: "telecom", hasProtocol },
        TELECOM_PLAYBOOK_V1,
        { type: "deadline_expired", at: AT },
      );
      expect(result.stage, `hasProtocol=${hasProtocol}`).toBe("jec_ready");
    }
  });

  it("leaves `draft` for `sac` when the protocol is pasted (§9.1's first edge)", () => {
    const result = nextStage(
      { stage: "draft", category: "telecom", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "protocol_entered", at: AT },
    );
    expect(result.stage).toBe("sac");
  });

  it("reopens a closed case when the item comes back, provisionally at `sac` — NOT RF-203's stage", () => {
    // RF-203's acceptance is "caso reabre no estágio anterior ao
    // fechamento", and this function cannot honour it: `current.stage` is
    // `closed` and §9.1 fixed the signature. `sac` is the safe provisional
    // answer (a fresh charge needs a fresh protocol, and `sac` is the one
    // channel that does not require a previous one). E6 owns RF-203 and has
    // the case's history; it must read the pre-close stage from `events` and
    // override this rather than treat it as the requirement met.
    const decision = decideTransition(
      { stage: "closed", category: "telecom", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "item_reappeared", at: AT },
    );
    expect(decision.stage).toBe("sac");
    // The case is open again, so this transition closed nothing — E6 clears
    // `cases.outcome` when it writes `case_reopened`.
    expect(decision.outcome).toBeNull();
  });

  it("does nothing when the item reappears on a case that is still open", () => {
    const decision = decideTransition(
      { stage: "regulator", category: "telecom", hasProtocol: true },
      TELECOM_PLAYBOOK_V1,
      { type: "item_reappeared", at: AT },
    );
    expect(decision).toEqual({ stage: "regulator", outcome: null, deadline: { kind: "keep" } });
  });

  it("ends the wait when the channel answers, without moving the stage", () => {
    const decision = decideTransition(
      { stage: "consumidor_gov", category: "telecom", hasProtocol: true },
      TELECOM_PLAYBOOK_V1,
      { type: "response_received", at: AT },
    );
    expect(decision).toEqual({
      stage: "consumidor_gov", outcome: null, deadline: { kind: "clear" },
    });
  });
});

describe("nextStage · which clock a transition starts (RF-181, RF-186)", () => {
  it("waits the playbook's calendar days once the protocol is in", () => {
    const decision = decideTransition(
      { stage: "sac", category: "telecom", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "protocol_entered", at: AT },
    );
    expect(decision.deadline).toEqual({
      kind: "wait", days: 7, businessDays: false, source: "playbook",
    });
  });

  it("waits the playbook's business days where the playbook says business days", () => {
    const decision = decideTransition(
      { stage: "regulator", category: "telecom", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "protocol_entered", at: AT },
    );
    expect(decision.deadline).toEqual({
      kind: "wait", days: 5, businessDays: true, source: "playbook",
    });
  });

  it("starts no wait for a stage the playbook gives zero response days (§20.2's jec_ready)", () => {
    const decision = decideTransition(
      { stage: "jec_ready", category: "telecom", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "protocol_entered", at: AT },
    );
    expect(decision.deadline).toEqual({ kind: "clear" });
  });

  it("starts no wait for a stage the playbook does not declare, rather than inventing days", () => {
    // §20.2 has no `ombudsman` entry, and §9.1 routes a card case there.
    const decision = decideTransition(
      { stage: "ombudsman", category: "card", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "protocol_entered", at: AT },
    );
    expect(decision.deadline).toEqual({ kind: "clear" });
  });

  it("gives a stage just escalated into RF-186's protocol window, not the channel's response days", () => {
    const decision = decideTransition(
      { stage: "sac", category: "telecom", hasProtocol: true },
      TELECOM_PLAYBOOK_V1,
      { type: "deadline_expired", at: AT },
    );
    expect(decision.stage).toBe("consumidor_gov");
    expect(decision.deadline).toEqual({
      kind: "wait", days: PROTOCOL_WINDOW_DAYS, businessDays: false, source: "protocol_window",
    });
  });

  it("counts RF-186's window in calendar days — a person is silent on Sundays too", () => {
    expect(PROTOCOL_WINDOW_DAYS).toBe(30);
  });

  it("clears the deadline on every closing transition", () => {
    for (const event of ["resolved", "user_abandon"] as const) {
      const result = nextStage(
        { stage: "regulator", category: "telecom", hasProtocol: true },
        TELECOM_PLAYBOOK_V1,
        { type: event, at: AT },
      );
      expect(result.stampDeadline, event).toBe(true);
      expect(result.nextDeadlineAt, event).toBeNull();
    }
  });
});

/**
 * The instants, through `computeDeadline` (E5 Task 1).
 *
 * `AT` is 2026-08-30T14:00:00Z — 11:00 on **Sunday 30 August 2026** in São
 * Paulo. Every date below was worked out by hand from that before the code
 * was run:
 *
 *  - **`sac`, 7 calendar days.** The start day does not count, so +7 lands on
 *    Sunday 6 September. That is not a business day, so it rolls to Monday
 *    the 7th — which is Independência do Brasil — and then to **Tuesday 8
 *    September**. Two rolls in one deadline, which is why this is the case
 *    worth asserting.
 *  - **`regulator`, 5 business days.** Mon 31 Aug, Tue 1, Wed 2, Thu 3,
 *    **Fri 4 September**. No weekend or holiday intervenes, so the
 *    business-day count lands short of the calendar-day one.
 *  - **RF-186's 30-day window.** +30 calendar days is **Tuesday 29
 *    September**, an ordinary business day, so it stands.
 *
 * `expiresAt` is the last millisecond of that civil day in São Paulo
 * (UTC−3), so it reads as 02:59:59.999 the following day in UTC. Asserting
 * the UTC instant rather than a formatted local date is deliberate: it is
 * the value that reaches `cases.next_deadline_at`, and a timezone slip in
 * either direction changes it.
 */
describe("nextStage · the instant a wait ends (RF-181)", () => {
  it("counts sac's seven calendar days off a Sunday, over a holiday Monday, onto the Tuesday", () => {
    const result = nextStage(
      { stage: "sac", category: "telecom", hasProtocol: false },
      TELECOM_PLAYBOOK_V1,
      { type: "protocol_entered", at: AT },
    );
    expect(result.stampDeadline).toBe(true);
    expect(result.nextDeadlineAt?.toISOString()).toBe("2026-09-09T02:59:59.999Z");
  });

  it("counts the regulator's five days as BUSINESS days — the playbook flag has to reach the calendar", () => {
    // Started on **Thursday 3 September 2026**, the Thursday before the 7
    // September holiday, which is RF-181's own acceptance shape. Five
    // business days: Fri 4 (1) — Sat, Sun and the holiday Monday are not
    // days — Tue 8 (2), Wed 9 (3), Thu 10 (4), **Fri 11 (5)**.
    //
    // The same five counted as CALENDAR days lands on Tuesday 8 September.
    // Both are asserted, because `AT`'s Sunday start happens to give the
    // same answer either way, and a test that cannot tell the two counts
    // apart does not test the flag at all.
    const thursdayBeforeTheHoliday = new Date("2026-09-03T14:00:00Z");
    const state = { stage: "regulator" as Stage, category: "telecom" as Category, hasProtocol: false };
    const event: StageEvent = { type: "protocol_entered", at: thursdayBeforeTheHoliday };

    const businessDays = nextStage(state, TELECOM_PLAYBOOK_V1, event);
    expect(businessDays.nextDeadlineAt?.toISOString()).toBe("2026-09-12T02:59:59.999Z");

    const asCalendarDays: Playbook = {
      stages: TELECOM_PLAYBOOK_V1.stages.map((entry) =>
        entry.stage === "regulator" ? { ...entry, businessDays: false } : entry,
      ),
    };
    const calendarDays = nextStage(state, asCalendarDays, event);
    expect(calendarDays.nextDeadlineAt?.toISOString()).toBe("2026-09-09T02:59:59.999Z");
  });

  it("counts RF-186's thirty-day window on an escalation", () => {
    const result = nextStage(
      { stage: "sac", category: "telecom", hasProtocol: true },
      TELECOM_PLAYBOOK_V1,
      { type: "deadline_expired", at: AT },
    );
    expect(result.stage).toBe("consumidor_gov");
    expect(result.nextDeadlineAt?.toISOString()).toBe("2026-09-30T02:59:59.999Z");
  });

  it("produces an instant for every transition that starts a wait, and only for those", () => {
    const offenders: string[] = [];
    for (const combination of COMBINATIONS) {
      const { stage, category, hasProtocol, event } = combination;
      const decision = decideTransition(
        { stage, category, hasProtocol }, TELECOM_PLAYBOOK_V1, { type: event, at: AT },
      );
      const result = transitionFor(combination);
      const wanted = decision.deadline.kind === "wait";
      if (wanted !== (result.nextDeadlineAt !== null)) offenders.push(label(combination));
      if (wanted && result.nextDeadlineAt !== null && result.nextDeadlineAt <= AT) {
        offenders.push(`${label(combination)} → deadline in the past`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("nextStage · a value from outside the declared vocabulary still throws", () => {
  it("throws rather than guessing a stage for an unknown `cases.stage`", () => {
    expect(() =>
      nextStage(
        { stage: "stalled" as Stage, category: "telecom", hasProtocol: true },
        TELECOM_PLAYBOOK_V1,
        { type: "deadline_expired", at: AT },
      ),
    ).toThrow(/not mapped.*stage=stalled/s);
  });

  it("throws rather than guessing a stage for an unknown category", () => {
    expect(() =>
      nextStage(
        { stage: "sac", category: "insurance" as Category, hasProtocol: true },
        TELECOM_PLAYBOOK_V1,
        { type: "deadline_expired", at: AT },
      ),
    ).toThrow(/not mapped.*category=insurance/s);
  });

  it("throws rather than guessing a stage for an unknown event", () => {
    expect(() =>
      nextStage(
        { stage: "sac", category: "telecom", hasProtocol: false },
        TELECOM_PLAYBOOK_V1,
        { type: "chargeback_filed" as StageEvent["type"], at: AT },
      ),
    ).toThrow(/not mapped.*event=chargeback_filed.*hasProtocol=false/s);
  });

  it("throws for an unknown event on a CLOSED case too, rather than answering it as a no-op", () => {
    // `closed` is answered before the event switch, so the vocabulary check
    // has to run first or an undeclared event here comes back as a
    // confident "nothing changes". E6's own `case_reopened`, arriving from
    // an older deploy, is the concrete way that happens.
    for (const event of ["case_reopened", "chargeback_filed"]) {
      expect(() =>
        nextStage(
          { stage: "closed", category: "telecom", hasProtocol: true },
          TELECOM_PLAYBOOK_V1,
          { type: event as StageEvent["type"], at: AT },
        ),
        event,
      ).toThrow(new RegExp(`not mapped.*stage=closed.*event=${event}`, "s"));
    }
  });
});
