import { addCivilDays, fromEpochDay, isBusinessDay, toEpochDay, type CivilDate } from "./holidays.js";

/**
 * RF-181's deadline arithmetic: how long the issuer has to answer, in
 * calendar days or business days, against the national holiday calendar in
 * `holidays.ts`.
 *
 * Pure. The playbook stage supplies `responseDays` and `businessDays`
 * (§7.4); `nextStage` supplies the instant the stage was entered and
 * stamps the result on `cases.next_deadline_at`.
 *
 * ---
 *
 * ## The three decisions this module makes
 *
 * ### 1. The start day does not count
 *
 * Brazilian procedural convention is *exclui-se o dia do começo,
 * inclui-se o dia do vencimento* — CPC art. 224, and Lei 9.784/1999
 * art. 66 for the administrative deadlines this system actually deals
 * with. So a one-day deadline entered on a Monday expires on the Tuesday,
 * and a business-day count begins on the first business day *after* the
 * start day. The tests state this directly rather than leaving it to be
 * inferred from a larger example.
 *
 * ### 2. A deadline never lands on a day nobody is open
 *
 * A business-day count cannot land on a weekend or a statutory holiday by
 * construction. A calendar-day count can, and when it does the deadline
 * rolls forward to the next business day — *prorroga-se até o primeiro dia
 * útil seguinte* (CPC art. 224 §1º; Lei 9.784/1999 art. 66 §1º).
 *
 * The product reason is the same as the legal one. If the seventh day
 * falls on a Sunday, the company had no day on which it could have
 * answered, and telling the person to escalate on Monday morning against a
 * Sunday expiry hands the company a defence about our arithmetic instead
 * of a conversation about their charge. Rolling forward costs at most two
 * days and removes that entirely.
 *
 * The roll-forward is applied to both counts. On a business-day count of
 * one day or more it is provably a no-op — the count already ends on a
 * business day — and it exists there so that the degenerate zero-day case
 * (§20.2's `jec_ready` carries `responseDays: 0`) answers the same on both
 * branches instead of two different ways.
 *
 * ### 3. The civil arithmetic happens in São Paulo; only the last step is
 * an instant
 *
 * `cases.next_deadline_at` is `timestamptz`, and a deadline computed from
 * UTC calendar components for someone in Brazil is a day off for every
 * case created after 21:00 local — roughly an eighth of the day, silently.
 * So the start instant is converted to a São Paulo civil date *first*, all
 * counting happens on civil dates, and the instant is produced *last*.
 *
 * The result carries `deadlineDate` alongside `expiresAt` on purpose:
 * whatever prints the date to the user (RF-182's document names both
 * dates) must not re-derive it from the instant in some other zone and
 * reintroduce the bug at the far end.
 *
 * `expiresAt` is the **last millisecond of the deadline day**, local. That
 * makes `now >= expiresAt` mean exactly "the day has ended", and makes the
 * stored timestamp render as the deadline date itself in any São Paulo
 * view — where the other obvious choice, midnight opening the next day,
 * renders as the wrong date on every screen that shows it.
 */

/**
 * `America/Sao_Paulo` is UTC−3 with no DST: Decreto 9.772/2019 revoked
 * horário de verão and nothing has reinstated it. A fixed offset is
 * therefore exact for every date this system computes — deadlines are
 * always in the present or the future — and it avoids depending on the
 * host's `Intl` timezone database, which is not identical across the
 * Windows development machines and the Linux CI this repo runs on.
 *
 * If Brazil ever brings DST back, this constant is where that lands, and
 * it stops being a constant.
 */
export const SAO_PAULO_UTC_OFFSET_MINUTES = -180;

const MILLIS_PER_DAY = 86_400_000;
const MILLIS_PER_MINUTE = 60_000;
const OFFSET_MILLIS = SAO_PAULO_UTC_OFFSET_MINUTES * MILLIS_PER_MINUTE;

export type DeadlineInput = {
  /** When the clock started — typically `cases.stage_entered_at`. */
  startedAt: Date;
  /** The playbook stage's `responseDays`. A whole number, zero or more. */
  days: number;
  /** The playbook stage's `businessDays`. */
  businessDays: boolean;
};

export type Deadline = {
  /** The São Paulo civil date the count started from. Not itself counted. */
  startDate: CivilDate;
  /** The last civil day of the deadline. Always a business day. */
  deadlineDate: CivilDate;
  /** The instant the deadline has passed: the deadline day's last millisecond, local. */
  expiresAt: Date;
};

/** The São Paulo civil date an instant falls on. */
export function toCivilDate(instant: Date): CivilDate {
  const millis = instant.getTime();
  if (Number.isNaN(millis)) {
    throw new RangeError("invalid Date: cannot read a civil date from it");
  }
  // Local wall-clock millis, floored to the day. `Math.floor` rather than
  // truncation so instants before 1970 do not round towards zero and land
  // on the following day.
  return fromEpochDay(Math.floor((millis + OFFSET_MILLIS) / MILLIS_PER_DAY));
}

/** The instant at which a São Paulo civil day has ended. */
function endOfCivilDay(date: CivilDate): Date {
  return new Date((toEpochDay(date) + 1) * MILLIS_PER_DAY - OFFSET_MILLIS - 1);
}

function rollForwardToBusinessDay(date: CivilDate): CivilDate {
  let cursor = date;
  while (!isBusinessDay(cursor)) cursor = addCivilDays(cursor, 1);
  return cursor;
}

export function computeDeadline(input: DeadlineInput): Deadline {
  const { startedAt, days, businessDays } = input;
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`deadline days must be a whole number of zero or more, got ${String(days)}`);
  }

  const startDate = toCivilDate(startedAt);

  let cursor = startDate;
  if (businessDays) {
    // Decision 1: the start day is never day 1. Each step lands on the
    // next business day, so weekends and statutory holidays pass without
    // being counted.
    for (let counted = 0; counted < days; counted += 1) {
      cursor = rollForwardToBusinessDay(addCivilDays(cursor, 1));
    }
  } else {
    cursor = addCivilDays(cursor, days);
  }

  // Decision 2. A no-op on any business-day count of one or more.
  const deadlineDate = rollForwardToBusinessDay(cursor);

  return { startDate, deadlineDate, expiresAt: endOfCivilDay(deadlineDate) };
}
