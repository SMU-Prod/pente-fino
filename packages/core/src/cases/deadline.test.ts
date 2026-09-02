import { describe, expect, it } from "vitest";
import { computeDeadline, SAO_PAULO_UTC_OFFSET_MINUTES, toCivilDate } from "./deadline.js";
import { addCivilDays } from "./holidays.js";

/** Noon in São Paulo, far from any day boundary, for tests not about the boundary. */
function middayIn(date: string): Date {
  return new Date(`${date}T12:00:00-03:00`);
}

describe("toCivilDate", () => {
  it("reads the São Paulo civil date of an instant, not the UTC one", () => {
    // 23:30 on 4 May in São Paulo is already 5 May in UTC.
    expect(toCivilDate(new Date("2026-05-05T02:30:00.000Z"))).toBe("2026-05-04");
    expect(toCivilDate(new Date("2026-05-04T15:00:00.000Z"))).toBe("2026-05-04");
  });

  it("puts the day boundary at 03:00 UTC, which is midnight in São Paulo", () => {
    expect(toCivilDate(new Date("2026-05-05T02:59:59.999Z"))).toBe("2026-05-04");
    expect(toCivilDate(new Date("2026-05-05T03:00:00.000Z"))).toBe("2026-05-05");
  });

  it("states the offset it assumes", () => {
    // UTC-3, no DST since Decreto 9.772/2019. A change here changes every
    // deadline in the system, so the number is asserted rather than trusted.
    expect(SAO_PAULO_UTC_OFFSET_MINUTES).toBe(-180);
  });

  it("refuses an invalid Date rather than answering about NaN", () => {
    expect(() => toCivilDate(new Date("not a date"))).toThrow(/invalid/i);
  });
});

describe("computeDeadline · RF-181 acceptance", () => {
  /**
   * Hand calculation, done before any code existed.
   *
   * Start: Thursday 30 April 2026. Friday 1 May 2026 is Dia do Trabalho, a
   * statutory national holiday. Ten business days, start day excluded:
   *
   *   Fri 01/05  holiday   —      Sat 02/05  weekend  —
   *   Sun 03/05  weekend   —      Mon 04/05  →  1
   *   Tue 05/05  →  2            Wed 06/05  →  3
   *   Thu 07/05  →  4            Fri 08/05  →  5
   *   Sat/Sun 09-10/05 weekend   Mon 11/05  →  6
   *   Tue 12/05  →  7            Wed 13/05  →  8
   *   Thu 14/05  →  9            Fri 15/05  →  10
   *
   * Expected: 2026-05-15.
   */
  it("lands a 10-business-day deadline started on the Thursday before a holiday on 2026-05-15", () => {
    const deadline = computeDeadline({
      startedAt: middayIn("2026-04-30"),
      days: 10,
      businessDays: true,
    });
    expect(deadline.startDate).toBe("2026-04-30");
    expect(deadline.deadlineDate).toBe("2026-05-15");
  });

  it("takes one calendar day longer than the same count in a holiday-free fortnight", () => {
    // Thursday 07/05/2026 starts an identical count — same weekday, same
    // two weekends crossed — with no holiday anywhere in its window. It
    // spans 14 days; the acceptance above spans 15. That difference is
    // Dia do Trabalho and nothing else, which is how we know the holiday
    // participated rather than the arithmetic happening to coincide.
    const withHoliday = computeDeadline({
      startedAt: middayIn("2026-04-30"),
      days: 10,
      businessDays: true,
    });
    const withoutHoliday = computeDeadline({
      startedAt: middayIn("2026-05-07"),
      days: 10,
      businessDays: true,
    });
    expect(withoutHoliday.deadlineDate).toBe("2026-05-21");
    expect(addCivilDays(withHoliday.startDate, 15)).toBe(withHoliday.deadlineDate);
    expect(addCivilDays(withoutHoliday.startDate, 14)).toBe(withoutHoliday.deadlineDate);
  });

  it("expires at the last millisecond of the deadline day in São Paulo", () => {
    const deadline = computeDeadline({
      startedAt: middayIn("2026-04-30"),
      days: 10,
      businessDays: true,
    });
    expect(deadline.expiresAt.toISOString()).toBe("2026-05-16T02:59:59.999Z");
  });

  it("has not expired at 23:00 on the deadline day and has by 00:30 the next", () => {
    const { expiresAt } = computeDeadline({
      startedAt: middayIn("2026-04-30"),
      days: 10,
      businessDays: true,
    });
    const stillFriday = new Date("2026-05-15T23:00:00-03:00");
    const saturdayMorning = new Date("2026-05-16T00:30:00-03:00");
    expect(stillFriday.getTime() < expiresAt.getTime()).toBe(true);
    expect(saturdayMorning.getTime() > expiresAt.getTime()).toBe(true);
  });
});

describe("computeDeadline · business days", () => {
  it("skips a moveable holiday, so the computus is load-bearing", () => {
    // Thursday 2 April 2026; Sexta-feira Santa is 3 April (Easter - 2).
    const deadline = computeDeadline({
      startedAt: middayIn("2026-04-02"),
      days: 10,
      businessDays: true,
    });
    expect(deadline.deadlineDate).toBe("2026-04-17");
  });

  it("counts across the turn of the year", () => {
    // Thursday 24 December 2026. Natal (25/12, Friday) and Confraternização
    // (01/01/2027, Friday) both fall inside the count.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-12-24"),
      days: 10,
      businessDays: true,
    });
    expect(deadline.deadlineDate).toBe("2027-01-11");
  });

  it("does not skip Carnaval, which is where the facultativo decision shows", () => {
    // Thursday 12 February 2026; Carnaval is Tuesday 17 February. Counting
    // it as a holiday would land this on the 27th instead of the 26th.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-02-12"),
      days: 10,
      businessDays: true,
    });
    expect(deadline.deadlineDate).toBe("2026-02-26");
    expect(deadline.deadlineDate).not.toBe("2026-02-27");
  });

  it("handles the playbook's five-day Anatel window (§20.2)", () => {
    const deadline = computeDeadline({
      startedAt: middayIn("2026-04-30"),
      days: 5,
      businessDays: true,
    });
    expect(deadline.deadlineDate).toBe("2026-05-08");
  });

  it("excludes the day the count starts on", () => {
    // One business day from a Monday is the Tuesday, never the Monday.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-05-04"),
      days: 1,
      businessDays: true,
    });
    expect(deadline.deadlineDate).toBe("2026-05-05");
  });

  it("starts counting on the first business day after a start on a Friday", () => {
    // Friday 8 May 2026: Saturday and Sunday are not day 1.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-05-08"),
      days: 1,
      businessDays: true,
    });
    expect(deadline.deadlineDate).toBe("2026-05-11");
  });
});

describe("computeDeadline · calendar days", () => {
  it("excludes the day the count starts on", () => {
    const deadline = computeDeadline({
      startedAt: middayIn("2026-05-04"),
      days: 1,
      businessDays: false,
    });
    expect(deadline.deadlineDate).toBe("2026-05-05");
  });

  it("leaves a deadline that already lands on a business day alone", () => {
    // §20.2's SAC stage: 7 calendar days. Started on a Wednesday, so both
    // the correct answer and an off-by-one are business days and the
    // roll-forward cannot mask a miscount.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-05-06"),
      days: 7,
      businessDays: false,
    });
    expect(deadline.deadlineDate).toBe("2026-05-13");
  });

  it("rolls forward off a weekend", () => {
    // 4 May + 5 calendar days is Saturday 9 May.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-05-04"),
      days: 5,
      businessDays: false,
    });
    expect(deadline.deadlineDate).toBe("2026-05-11");
  });

  it("rolls forward off a holiday, and past the weekend behind it", () => {
    // 24 April + 7 calendar days is Friday 1 May, Dia do Trabalho.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-04-24"),
      days: 7,
      businessDays: false,
    });
    expect(deadline.deadlineDate).toBe("2026-05-04");
  });

  it("does not roll forward off Carnaval", () => {
    // 10 February + 7 calendar days is Tuesday 17 February, Carnaval.
    const deadline = computeDeadline({
      startedAt: middayIn("2026-02-10"),
      days: 7,
      businessDays: false,
    });
    expect(deadline.deadlineDate).toBe("2026-02-17");
  });
});

describe("computeDeadline · the timezone boundary", () => {
  // Each of these starts at 23:30 on 4 May in São Paulo, which is already
  // 5 May in UTC. Reading the start date in UTC shifts every answer below
  // by a day, which is the difference between a valid escalation and one
  // the company can call premature.
  const lateAtNight = new Date("2026-05-05T02:30:00.000Z");

  it("reads the start date in São Paulo, not in UTC", () => {
    expect(computeDeadline({ startedAt: lateAtNight, days: 7, businessDays: false }).startDate).toBe(
      "2026-05-04",
    );
  });

  it("gives a calendar-day deadline the same answer as noon on the same local day", () => {
    const atNight = computeDeadline({ startedAt: lateAtNight, days: 7, businessDays: false });
    const atNoon = computeDeadline({ startedAt: middayIn("2026-05-04"), days: 7, businessDays: false });
    expect(atNight.deadlineDate).toBe("2026-05-11");
    expect(atNight.deadlineDate).toBe(atNoon.deadlineDate);
    expect(atNight.expiresAt.getTime()).toBe(atNoon.expiresAt.getTime());
  });

  it("gives a business-day deadline the same answer as noon on the same local day", () => {
    const atNight = computeDeadline({ startedAt: lateAtNight, days: 10, businessDays: true });
    expect(atNight.deadlineDate).toBe("2026-05-18");
    expect(atNight.deadlineDate).not.toBe("2026-05-19");
  });
});

describe("computeDeadline · degenerate and invalid input", () => {
  it("treats zero days as no wait at all, identically on both counts", () => {
    // §20.2's `jec_ready` stage carries responseDays 0. Nothing is granted,
    // so the deadline is the start day itself — rolled forward only because
    // a deadline can never fall on a day nobody is open to act on.
    const calendar = computeDeadline({
      startedAt: middayIn("2026-05-02"), // a Saturday
      days: 0,
      businessDays: false,
    });
    const business = computeDeadline({
      startedAt: middayIn("2026-05-02"),
      days: 0,
      businessDays: true,
    });
    expect(calendar.deadlineDate).toBe("2026-05-04");
    expect(business.deadlineDate).toBe(calendar.deadlineDate);
  });

  it("refuses an invalid start instant", () => {
    expect(() =>
      computeDeadline({ startedAt: new Date("not a date"), days: 7, businessDays: false }),
    ).toThrow(/invalid/i);
  });

  it("refuses a day count that is not a whole non-negative number", () => {
    const bad = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const days of bad) {
      expect(() => computeDeadline({ startedAt: middayIn("2026-05-04"), days, businessDays: true })).toThrow(
        RangeError,
      );
    }
  });
});
