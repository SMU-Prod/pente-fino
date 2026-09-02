import { and, eq, inArray, isNotNull, isNull, lte, max, ne } from "drizzle-orm";
import {
  PROTOCOL_WINDOW_DAYS, newId, nextStage, toCivilDate,
  type CaseOutcome, type EventType, type Playbook, type Stage,
} from "@pentefino/core";
import type { TaskHandler } from "@pentefino/adapters";
import { resolveNow } from "../clock.js";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";

const { caseProtocols, cases, events, issuers } = schema;

export type CaseDeadlinesDeps = {
  db: Database;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * §9.1's "qualquer ──(60d sem ação do usuário)──▶ closed{outcome:abandoned}".
 *
 * Derived rather than written as `60`, because it is not an independent
 * number: RF-186 describes the same span as two windows back to back — "sem
 * protocolo por 30 dias entra em `stalled` … sem ação por mais 30 dias,
 * fecha como `abandoned`". `PROTOCOL_WINDOW_DAYS` is the first of the two,
 * and if it ever moves this must move with it.
 *
 * Calendar days, and measured as a plain elapsed duration rather than
 * through `computeDeadline`. Two reasons it is the one span in this block
 * that is *not* civil-date arithmetic: it counts a person's silence, and a
 * person is silent on weekends and holidays too (so no business-day count
 * and no roll-forward to the next business day — a roll-forward would push
 * an abandonment two days late for no benefit to anyone); and nothing ever
 * prints this date to a user or to a company, so `deadline.ts`'s third
 * decision — never re-derive a *printed* date outside São Paulo — has
 * nothing to protect here.
 */
export const ABANDONMENT_WINDOW_DAYS = 2 * PROTOCOL_WINDOW_DAYS; // 60

const ABANDONMENT_WINDOW_MS = ABANDONMENT_WINDOW_DAYS * DAY_MS;

/**
 * What counts as "ação do usuário" for §9.1's 60-day clock.
 *
 * An explicit allowlist, not a blocklist, and that direction is the whole
 * point. A blocklist fails open: the next event type anybody adds would
 * silently start resetting this clock, and a case nobody has touched in a
 * year would keep looking alive because a scheduled job wrote a row against
 * it. An allowlist fails closed — a new event type does nothing until
 * somebody decides it is a person acting.
 *
 * Typed `readonly EventType[]` so a rename in `packages/core/src/events.ts`
 * breaks this build instead of quietly emptying the list.
 *
 * **Included** — every one of these is a human doing something about *this
 * case*: creating it, reading the laudo, triaging a finding, generating or
 * editing or sending the contest letter, pasting a protocol number,
 * confirming the outcome, reopening it, sharing the card, or claiming the
 * anonymous session it started in.
 *
 * **Excluded, and why**, since silence about an exclusion is how this kind
 * of list rots:
 *
 *  - `deadline_expired`, `stage_advanced`, `case_stalled` — *this job's own
 *    writes*. If they counted, every stall would reset the clock that the
 *    stall is a step towards, and RF-186's second window could never close.
 *    This is the exclusion the whole allowlist exists for.
 *  - `monthly_digest_sent`, `monitor_email_received`, `diff_run` — the
 *    system sending or receiving something on the user's behalf is not the
 *    user acting on the case.
 *  - `public_report_viewed` — a *visitor* opened a shared link. That is
 *    somebody else's activity, and treating it as the owner's would let a
 *    link circulating on WhatsApp keep a dead case open indefinitely.
 *  - the `invoice_*`, `finding_created`, `rule_*` and `proposal_*` families
 *    — pipeline, engine and admin events, none of them a person touching
 *    this case.
 *  - `subscription_started`, `subscription_failed` — billing, and not
 *    attached to a case at all.
 */
export const USER_ACTION_EVENTS: readonly EventType[] = [
  "case_created",
  "report_viewed",
  "finding_dismissed",
  "finding_confirmed",
  "contest_generated",
  "contest_edited",
  "contest_marked_sent",
  "protocol_entered",
  "outcome_confirmed",
  "case_reopened",
  "card_shared",
  "session_claimed",
];

/** The reason a `stage_advanced` row gives for the move it records. */
type AdvanceReason = "deadline_expired" | "inactivity";

type CaseRow = {
  id: string;
  userId: string;
  invoiceId: string;
  stage: Stage;
  stageEnteredAt: Date;
  nextDeadlineAt: Date | null;
  createdAt: Date;
  category: "telecom" | "card" | "energy" | "water";
  playbook: Playbook | null;
};

/**
 * Half of the optimistic guard (A4, A8). `next_deadline_at` is nullable, and
 * `= NULL` is never true in SQL, so the null case has to be `IS NULL` or the
 * guard would silently match nothing and every abandonment would be dropped
 * as a "concurrent write".
 */
function deadlineGuard(observed: Date | null) {
  return observed === null ? isNull(cases.nextDeadlineAt) : eq(cases.nextDeadlineAt, observed);
}

function playbookChannel(playbook: Playbook, stage: Stage): string | null {
  return playbook.stages.find((entry) => entry.stage === stage)?.channel ?? null;
}

/**
 * One `events` row for a case, written on the caller's transaction.
 *
 * `caseId`, `userId` and `invoiceId` are all set on every row this job
 * writes: an event nobody can correlate is worthless, and `cases.invoice_id`
 * is NOT NULL so there is never an excuse to leave it off.
 */
async function record(
  row: { id: string; userId: string; invoiceId: string },
  tx: Database,
  type: EventType,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(events).values({
    id: newId("evt"), caseId: row.id, userId: row.userId, invoiceId: row.invoiceId,
    type, payload,
  });
}

function advancePayload(
  from: Stage, to: Stage, reason: AdvanceReason, outcome: CaseOutcome | null,
): Record<string, unknown> {
  return { from, to, reason, outcome };
}

/**
 * A8: one case's failure must not sink the run. There is no `events` row for
 * it — the failure is in *this* job, not a transition of the case, and
 * inventing a case-level event for a bug here would put a lie in the
 * timeline. `console.error` is what a scheduled Node process has; the
 * observability gap is named in `createCaseDeadlinesTask`'s doc comment.
 */
function reportCaseFailure(caseId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`case-deadlines: case ${caseId} failed and was skipped: ${message}`);
}

/**
 * RF-180's durable wait, as a sweep over rows.
 *
 * ## What this is
 *
 * A case waiting on a channel is a `cases.next_deadline_at` in the future.
 * This job runs periodically, finds the ones that have passed, asks §9.1's
 * `nextStage` what happens, and writes the answer back — the new stage, the
 * next deadline, and the `events` rows that make the move readable
 * afterwards (A3). RF-186's other half runs first: an open case whose user
 * has done nothing for `ABANDONMENT_WINDOW_DAYS` closes as `abandoned`.
 *
 * ## What it gives, and what it does not, next to ADR-02
 *
 * ADR-02 chose Trigger.dev "para escalada", for durable multi-day waits,
 * long-running tasks and **replay**. Two of those three are not here, and
 * saying so plainly is the point of this paragraph:
 *
 *  - **Durability is genuinely here.** That is not a claim about this file;
 *    it is a claim about `cases.next_deadline_at` and the partial index
 *    `cases_next_deadline`, which have been in the schema since E0. A row
 *    survives a redeploy, a crash and a cold region the way an in-process
 *    timer never can, and `apps/jobs/test/case-deadlines.test.ts` proves it
 *    by closing the database process and reopening it. This is the E5
 *    design's §3 decision — "a durabilidade vem do banco, não do
 *    Trigger.dev" — and it is the opposite of E3's fire-and-forget route
 *    (`apps/web/app/api/invoices/[id]/process/route.ts`), which is honest
 *    about being a stopgap.
 *  - **Replay is not here.** There is no run history, no "re-run this case
 *    from the step that failed", and no way to answer "what did this job do
 *    at 03:00 on Tuesday" except by reading `events` and inferring. A case
 *    whose transition threw (see the per-case isolation below) is simply
 *    picked up again by the next sweep, from whatever state it is now in —
 *    which is a retry, not a replay, and loses whatever the previous attempt
 *    was in the middle of.
 *  - **Observability is not here either.** No traces, no per-run metrics, no
 *    queue depth, no alert when a sweep stops happening. §15.3 already lists
 *    "Fila atrasada · Trigger.dev com espera > 5 min" as an alert this
 *    product wants, and nothing in this file can raise it. If the scheduler
 *    that calls this handler stops calling it, every case silently stops
 *    advancing and nothing anywhere says so.
 *
 * So: this is a sweeper, not a workflow engine, and nobody should plan
 * around it as one. When Trigger.dev arrives it takes over *scheduling and
 * replay*; the durable state stays exactly where it already is.
 *
 * ## Ordering, and why the abandonment sweep is first
 *
 * A case can be both past its deadline and past 60 days of user silence. It
 * should close, not escalate: escalating means generating the next document
 * for somebody to send, and there is nobody driving this case. So the
 * inactivity sweep runs to completion first, and the expiry query is only
 * *issued* afterwards — its `stage <> 'closed'` filter then excludes
 * everything the first sweep just closed.
 *
 * The abandonment sweep cannot run off `next_deadline_at` at all, which is
 * the reason it is a separate scan rather than a branch inside the first
 * one: `response_received` clears the column, so a case waiting on the
 * *user* has no pending deadline and would never appear in an expiry scan.
 * §9.1's clock is "60d sem ação do usuário" — user inactivity, not a
 * channel's deadline.
 *
 * ## Concurrency and idempotency (A4, A8)
 *
 * Every write is guarded optimistically: the `UPDATE` matches on the stage
 * *and* the deadline this run observed, and uses `RETURNING`. An empty
 * result means another writer (a second job instance, or a user posting a
 * protocol) moved the case between the read and the write, so this run
 * writes no events for it and moves on. Nothing is retried in-place; the
 * next sweep sees whatever the winner left behind.
 *
 * The state change and its events are one transaction, for the reason
 * `ingest.ts` states: a crash between them would leave a case advanced with
 * nothing in `events` to show it, and A3 promises the opposite.
 *
 * One case's failure never sinks the run (A8, the way `expire-files.ts`
 * isolates each invoice) — a malformed playbook is enough to make §9.1's
 * table throw, and that must cost one case, not every case.
 */
export function createCaseDeadlinesTask(deps: CaseDeadlinesDeps): TaskHandler {
  const { db } = deps;

  /**
   * §9.1's 60-day clock. Closes an open case whose user has done nothing —
   * see `USER_ACTION_EVENTS` for what "nothing" means — for
   * `ABANDONMENT_WINDOW_DAYS`.
   *
   * `max(events.occurred_at)` over the allowlisted rows is the last user
   * action, read through the `events_case_time` index on
   * `(case_id, occurred_at)`. A case with no such event yet falls back to
   * `cases.created_at`, which is what makes the very first 60 days countable
   * at all — and it keeps this job correct whether or not Task 4's
   * `case_created` event has landed yet.
   *
   * ---
   *
   * **This implements §9.1 literally, and that diverges from one reading of
   * RF-186. Deliberately.**
   *
   * RF-186 says "sem protocolo por 30 dias entra em `stalled` … sem ação por
   * mais 30 dias, fecha como `abandoned`", which can be read as "30 days
   * *after the stall*". On the path RF-186 is actually written about the two
   * readings coincide exactly: a case is created, never gets a protocol, so
   * the last user action is at t0, it stalls at t0+30, and it is abandoned
   * at t0+60 — which is 30 days after the stall either way.
   *
   * They come apart when a user action happens and a stall follows later.
   * Protocol pasted at t0; the company stays silent; the SAC deadline
   * expires at t0+7 and the case escalates; nobody writes to the new channel
   * either, so it stalls at t0+37. This job abandons it at t0+60 — 23 days
   * after the stall, not 30.
   *
   * The alternative is to abandon at the *later* of "60 days since the last
   * user action" and "30 days since the stall". It is gentler to the user,
   * and it is what a reader of RF-186 alone would expect. It is not what is
   * implemented, because §9.1's arrow is unconditional — "qualquer ──(60d
   * sem ação do usuário)──▶ closed{outcome:abandoned}" — and it is the state
   * machine, where RF-186 is prose describing the common path through it. A
   * second clock keyed on the stall would also need the stall's own
   * timestamp as durable state, which today exists only as a `case_stalled`
   * row.
   *
   * If somebody decides the gentler reading is the product decision, this is
   * the function to change, and RF-186 should be amended to say so
   * explicitly rather than leaving the next reader to rediscover the
   * ambiguity.
   */
  async function sweepAbandoned(now: Date): Promise<void> {
    const candidates = await db
      .select({
        id: cases.id,
        userId: cases.userId,
        invoiceId: cases.invoiceId,
        stage: cases.stage,
        stageEnteredAt: cases.stageEnteredAt,
        nextDeadlineAt: cases.nextDeadlineAt,
        createdAt: cases.createdAt,
        category: issuers.category,
        playbook: issuers.playbook,
        lastUserActionAt: max(events.occurredAt),
      })
      .from(cases)
      .innerJoin(issuers, eq(issuers.id, cases.issuerId))
      .leftJoin(
        events,
        and(eq(events.caseId, cases.id), inArray(events.type, [...USER_ACTION_EVENTS])),
      )
      .where(ne(cases.stage, "closed"))
      // Both primary keys, not just `cases.id`: Postgres's
      // functional-dependency shortcut ("group by the PK, select any column
      // of that table") is per-table, so grouping by the case alone leaves
      // `issuers.category` and `issuers.playbook` ungrouped and the query is
      // rejected outright.
      .groupBy(cases.id, issuers.id);

    for (const row of candidates) {
      try {
        const lastActionAt = row.lastUserActionAt ?? row.createdAt;
        if (now.getTime() - lastActionAt.getTime() < ABANDONMENT_WINDOW_MS) continue;

        const transition = nextStage(
          {
            stage: row.stage,
            category: row.category,
            // §9.1's table answers `user_abandon` with `closed{abandoned}`
            // from every stage before it ever reads this flag, so filling it
            // in honestly would mean a `case_protocols` read whose result is
            // thrown away.
            hasProtocol: false,
          },
          row.playbook ?? { stages: [] },
          { type: "user_abandon", at: now },
        );

        await db.transaction(async (tx) => {
          const updated = await tx
            .update(cases)
            .set({
              stage: transition.stage,
              stageEnteredAt: now,
              outcome: transition.outcome,
              closedAt: now,
              // The enum member that exists for "nobody confirmed it".
              // §1.4's north-star metric is *confirmed* recovered reais, and
              // `recoveredCents` is deliberately left exactly as it was: a
              // case that evaporated is not the same as a case that was
              // denied, and it must not contribute a number nobody stood
              // behind.
              outcomeConfirmedBy: "none",
              nextDeadlineAt: null,
              updatedAt: now,
            })
            .where(and(
              eq(cases.id, row.id),
              eq(cases.stage, row.stage),
              deadlineGuard(row.nextDeadlineAt),
            ))
            .returning({ id: cases.id });
          if (updated.length === 0) return; // somebody else moved it; write nothing

          // No `outcome_confirmed` event: §15.2's funnel ends with it and
          // §1.4 counts it, and an abandonment is the opposite of a
          // confirmed outcome. No `case_abandoned` event either — this
          // `stage_advanced` to `closed`, plus `cases.outcome` and
          // `cases.closed_at`, already record the whole thing.
          await record(
            row, tx, "stage_advanced",
            {
              ...advancePayload(row.stage, transition.stage, "inactivity", transition.outcome),
              lastUserActionAt: lastActionAt.toISOString(),
              observedAt: now.toISOString(),
              windowDays: ABANDONMENT_WINDOW_DAYS,
            },
          );
        });
      } catch (error) {
        reportCaseFailure(row.id, error);
      }
    }
  }

  /**
   * The expiry sweep: every open case whose stamped deadline has passed.
   *
   * `next_deadline_at` holds the deadline day's *last millisecond* in São
   * Paulo (see `deadline.ts`), so `next_deadline_at <= now` means exactly
   * "the deadline day has ended", with no off-by-a-day in either direction.
   */
  async function sweepExpired(now: Date): Promise<void> {
    const expired: CaseRow[] = await db
      .select({
        id: cases.id,
        userId: cases.userId,
        invoiceId: cases.invoiceId,
        stage: cases.stage,
        stageEnteredAt: cases.stageEnteredAt,
        nextDeadlineAt: cases.nextDeadlineAt,
        createdAt: cases.createdAt,
        category: issuers.category,
        playbook: issuers.playbook,
      })
      .from(cases)
      .innerJoin(issuers, eq(issuers.id, cases.issuerId))
      .where(and(
        ne(cases.stage, "closed"),
        isNotNull(cases.nextDeadlineAt),
        lte(cases.nextDeadlineAt, now),
      ));
    if (expired.length === 0) return;

    // `hasProtocol` is per *stage*, not per case: it answers "has the user
    // pasted the protocol number for the channel this case is sitting in
    // *now*". That is what separates "the channel went silent" (escalate)
    // from "the person never wrote to it" (RF-186's stall), and a case that
    // reached `regulator` on the strength of a `sac` protocol must not be
    // read as having written to Anatel.
    const rows = await db
      .select()
      .from(caseProtocols)
      .where(inArray(caseProtocols.caseId, expired.map((row) => row.id)));
    const protocols = new Map<string, { protocolNumber: string; registeredAt: Date }>();
    for (const row of rows) {
      const key = `${row.caseId} ${row.stage}`;
      const current = protocols.get(key);
      // Nothing stops a stage carrying more than one protocol (a second call
      // to the same SAC). The most recently registered one is the number the
      // next document should cite.
      if (!current || current.registeredAt < row.registeredAt) {
        protocols.set(key, { protocolNumber: row.protocolNumber, registeredAt: row.registeredAt });
      }
    }

    for (const row of expired) {
      try {
        await expireOne(row, protocols.get(`${row.id} ${row.stage}`), now);
      } catch (error) {
        reportCaseFailure(row.id, error);
      }
    }
  }

  async function expireOne(
    row: CaseRow,
    protocol: { protocolNumber: string } | undefined,
    now: Date,
  ): Promise<void> {
    const deadlineAt = row.nextDeadlineAt;
    if (!deadlineAt) return; // guarded by the query; narrows for TS

    // Task 2's decision: §20.2 only supplies a channel's text and its
    // deadline. A missing playbook must not make the case skip a rung of
    // §9.1's ladder — that would push somebody towards small-claims court
    // because an ops row was never filled in — so the graph routes it
    // anyway, on RF-186's 30-day window, and the gap is recorded rather
    // than swallowed.
    const playbookMissing = row.playbook === null;
    const playbook = row.playbook ?? { stages: [] };
    const hasProtocol = protocol !== undefined;

    const transition = nextStage(
      { stage: row.stage, category: row.category, hasProtocol },
      playbook,
      { type: "deadline_expired", at: now },
    );

    // §9.1's `stalled` sub-state. The discriminator is `hasProtocol ===
    // false` on a `deadline_expired` — *not* "the stage did not change": a
    // stall out of `regulator` really does move the case back to `sac`, and
    // a `sac` case that escalates really does keep no protocol.
    //
    // The extra `transition.stage === "sac"` is what excludes the one case
    // where a missing protocol is not a stall: `jec_ready` has nothing after
    // it to escalate to, so §9.1's table leaves the case where it is and
    // clears the clock. Nobody stalled there; the ladder simply ended.
    const stalled = !hasProtocol && transition.stage === "sac";
    const stageChanged = transition.stage !== row.stage;

    // Defensive, and unreachable through §9.1's table today: every
    // `deadline_expired` row either starts a new wait or clears the column.
    // If one ever answered `keep` without moving the stage, the deadline
    // would stay in the past and this job would re-expire the same case, and
    // write another pair of events, on every run forever. Writing nothing is
    // the safe failure: the case sits still and visibly does not advance,
    // instead of filling `events` with an escalation that never happened.
    if (!transition.stampDeadline && !stageChanged) return;

    const update: {
      stage: Stage; updatedAt: Date; stageEnteredAt?: Date; nextDeadlineAt?: Date | null;
    } = { stage: transition.stage, updatedAt: now };
    if (stageChanged) update.stageEnteredAt = now;
    // `stampDeadline: false` means "leave the column exactly as it is", so
    // the key is absent rather than set to undefined.
    if (transition.stampDeadline) update.nextDeadlineAt = transition.nextDeadlineAt;

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(cases)
        .set(update)
        .where(and(
          eq(cases.id, row.id),
          eq(cases.stage, row.stage),
          deadlineGuard(row.nextDeadlineAt),
        ))
        .returning({ id: cases.id });
      if (updated.length === 0) return; // somebody else moved it; write nothing

      // RF-182: the next document has to name the channel, the protocol
      // number and *both* dates, and the E5 design is explicit that the
      // expiry is "um fato registrado em `events`, não um cálculo refeito na
      // hora de gerar o texto". So everything that document needs is written
      // here, at the moment it was true.
      //
      // The civil dates are computed with `toCivilDate` and stored as
      // strings beside the instants on purpose: whatever prints them must
      // not re-derive a date from a `timestamptz` in some other zone, which
      // is the off-by-a-day `deadline.ts`'s third decision exists to
      // prevent.
      await record(row, tx, "deadline_expired", {
        stage: row.stage,
        stageEnteredAt: row.stageEnteredAt.toISOString(),
        stageEnteredDate: toCivilDate(row.stageEnteredAt),
        deadlineAt: deadlineAt.toISOString(),
        deadlineDate: toCivilDate(deadlineAt),
        observedAt: now.toISOString(),
        channel: playbookChannel(playbook, row.stage),
        protocolNumber: protocol?.protocolNumber ?? null,
        hasProtocol,
        stalled,
        playbookMissing,
      });

      if (stalled) {
        // §9.1 calls `stalled` a *sub-estado* that "volta a sac", and
        // `cases_stage_values` rejects it as a stage, so this row is the
        // only record that it happened. In the common `sac → sac` stall
        // there is no `stage_advanced` to infer it from either.
        await record(row, tx, "case_stalled", {
          stalledIn: row.stage,
          returnedTo: transition.stage,
          nextDeadlineAt: transition.nextDeadlineAt?.toISOString() ?? null,
          windowDays: PROTOCOL_WINDOW_DAYS,
          observedAt: now.toISOString(),
        });
      }

      // Only when the stage actually moved. A `stage_advanced` whose payload
      // reads `from: "sac", to: "sac"` is a lie, and Task 4's case timeline
      // would render it as an advance that never happened.
      if (stageChanged) {
        await record(row, tx, "stage_advanced", advancePayload(
          row.stage, transition.stage, "deadline_expired", transition.outcome,
        ));
      }
    });
  }

  return async function caseDeadlines(payload: Record<string, unknown>): Promise<void> {
    const now = resolveNow(payload, "case-deadlines");
    await sweepAbandoned(now);
    await sweepExpired(now);
  };
}
