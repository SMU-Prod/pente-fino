/**
 * The Brazilian national holiday calendar that RF-181's deadline
 * arithmetic counts against.
 *
 * **This is reference data, not a constant.** The fixed dates are federal
 * law and the list changes *by law* — 20 de novembro became a national
 * holiday in 2024, inside this codebase's own lifetime. §12.3 treats
 * ANEEL's tariff tables the same way: every entry records the instrument
 * that created it and the year it took effect, so the next change of law
 * is an edit to a table with a visible provenance rather than an
 * archaeology exercise. `HOLIDAY_CALENDAR_VERSION` below is the date this
 * table was last reconciled against the law; move it when you touch the
 * table.
 *
 * **The moveable dates are derived, not listed.** Three of them hang off
 * Easter, which moves every year, so hardcoding them would silently expire.
 * `easterSunday` implements the Anonymous Gregorian computus.
 *
 * Civil dates are `YYYY-MM-DD` strings throughout — a calendar has no
 * business holding instants, and mixing the two is how a deadline ends up
 * a day off. The instant boundary lives in `deadline.ts`.
 */

/** A civil date in `YYYY-MM-DD`. No time, no zone. */
export type CivilDate = string;

/**
 * `statutory` — a national holiday by federal law; nobody is expected to
 * be working, so it never counts as a business day.
 *
 * `religious_municipal` — Lei 9.093/1995 art. 2º: a day of guard declared by
 * *municipal* law, capped at four per municipality, with Sexta-Feira da
 * Paixão named in the statute. No federal law puts it on a national
 * calendar, so it is not `statutory` — but it is declared in practically
 * every município and there is no banking expediente anywhere in the
 * country on it, so it **is** counted by the deadline calculator.
 *
 * `optional` — *ponto facultativo*: the federal executive suspends its own
 * expediente by annual decree, and nothing obliges anyone else to. Recorded
 * here because the fact is real and a caller may want to display it, but
 * **not** counted as a holiday by the deadline calculator. See
 * `CARNAVAL_AND_CORPUS_CHRISTI` below for the reasoning.
 *
 * `optional` is therefore the only value that does not stop a clock, which
 * is how `isBusinessDay` reads it — a new observance added later counts
 * unless it is deliberately made facultativo.
 */
export type HolidayObservance = "statutory" | "religious_municipal" | "optional";

export type NationalHoliday = {
  date: CivilDate;
  /** pt-BR, as the date is named in the law and on a calendar. */
  name: string;
  observance: HolidayObservance;
  /** The instrument this date comes from. Never blank. */
  source: string;
};

/**
 * The date this table was last reconciled against federal law. Bump it
 * whenever an entry is added, removed or re-sourced, so a stale calendar
 * is visible rather than assumed current.
 */
export const HOLIDAY_CALENDAR_VERSION = "2026-09-01";

/**
 * The years this calendar answers for. The lower bound is Lei 662/1949,
 * the oldest instrument in the table — before it the fixed list has no
 * basis and any answer would be invented. The upper bound is arbitrary but
 * finite: it exists so a corrupted year (a `NaN` that survived a parse, a
 * timestamp used where a year belonged) throws instead of producing a
 * confident wrong date.
 */
export const HOLIDAY_CALENDAR_FIRST_YEAR = 1949;
export const HOLIDAY_CALENDAR_LAST_YEAR = 2199;

const MILLIS_PER_DAY = 86_400_000;
const CIVIL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

const SATURDAY = 6;
const SUNDAY = 0;

function assertYearInRange(year: number): void {
  if (
    !Number.isInteger(year) ||
    year < HOLIDAY_CALENDAR_FIRST_YEAR ||
    year > HOLIDAY_CALENDAR_LAST_YEAR
  ) {
    throw new RangeError(
      `holiday calendar covers ${HOLIDAY_CALENDAR_FIRST_YEAR}-${HOLIDAY_CALENDAR_LAST_YEAR}, got ${String(year)}`,
    );
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function format(year: number, month: number, day: number): CivilDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * Days since 1970-01-01. The unit every other function here does its
 * arithmetic in, because adding days to an integer cannot roll a month
 * over wrongly and cannot be moved by a timezone.
 */
export function toEpochDay(date: CivilDate): number {
  if (typeof date !== "string" || !CIVIL_DATE_SHAPE.test(date)) {
    throw new RangeError(`not a YYYY-MM-DD civil date: ${JSON.stringify(date)}`);
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const millis = Date.UTC(year, month - 1, day);
  // `Date.UTC` rolls impossible dates over silently: 2026-02-30 becomes
  // 2 March, and `2025-02-29` becomes 1 March. Round-tripping is what
  // catches that — a date that does not survive the trip did not exist.
  if (Number.isNaN(millis) || fromEpochDay(millis / MILLIS_PER_DAY) !== date) {
    throw new RangeError(`not a civil date that exists: ${date}`);
  }
  return millis / MILLIS_PER_DAY;
}

export function fromEpochDay(epochDay: number): CivilDate {
  const at = new Date(epochDay * MILLIS_PER_DAY);
  return format(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/** Sunday is 0, Saturday is 6 — the same numbering as `Date#getUTCDay`. */
export function civilDayOfWeek(date: CivilDate): number {
  // 1970-01-01 was a Thursday (4). `%` in JS keeps the sign of the
  // dividend, so dates before 1970 need the extra `+ 7` to stay in range.
  return (((toEpochDay(date) + 4) % 7) + 7) % 7;
}

export function addCivilDays(date: CivilDate, days: number): CivilDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * Easter Sunday, by the Anonymous Gregorian computus (also called the
 * Meeus/Jones/Butcher algorithm). Three Brazilian holidays are defined as
 * offsets from it.
 *
 * The variable names are the ones the published algorithm uses. They mean
 * nothing on their own and renaming them to something plausible is how the
 * algorithm gets subtly broken, so they are left alone; the tests pin
 * seven independently known Easters plus the two properties that bound the
 * result (it is always a Sunday, always between 22 March and 25 April).
 */
export function easterSunday(year: number): CivilDate {
  assertYearInRange(year);

  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return format(year, month, day);
}

type FixedHoliday = {
  month: number;
  day: number;
  name: string;
  source: string;
  /**
   * First year the date was a national holiday. Recorded for provenance —
   * this system only ever computes deadlines for the present and the
   * future, so the value that matters is that a *future* change of law has
   * an obvious place to go, the way `sinceYear: 2024` below was the shape
   * Lei 14.759/2023 needed when it arrived.
   */
  sinceYear: number;
};

const FIXED_HOLIDAYS: readonly FixedHoliday[] = [
  {
    month: 1,
    day: 1,
    name: "Confraternização Universal",
    source: "Lei 662/1949, art. 1º",
    sinceYear: 1949,
  },
  {
    month: 4,
    day: 21,
    name: "Tiradentes",
    source: "Lei 1.266/1950; consolidado na Lei 662/1949 pela Lei 10.607/2002",
    sinceYear: 1950,
  },
  {
    month: 5,
    day: 1,
    name: "Dia do Trabalho",
    source: "Lei 662/1949, art. 1º",
    sinceYear: 1949,
  },
  {
    month: 9,
    day: 7,
    name: "Independência do Brasil",
    source: "Lei 662/1949, art. 1º",
    sinceYear: 1949,
  },
  {
    month: 10,
    day: 12,
    name: "Nossa Senhora Aparecida",
    source: "Lei 6.802/1980",
    sinceYear: 1980,
  },
  {
    month: 11,
    day: 2,
    name: "Finados",
    source: "Lei 10.607/2002, que deu nova redação ao art. 1º da Lei 662/1949",
    sinceYear: 2002,
  },
  {
    month: 11,
    day: 15,
    name: "Proclamação da República",
    source: "Lei 662/1949, art. 1º",
    sinceYear: 1949,
  },
  {
    // The worked example of why this file is a sourced table and not a
    // constant: this date became a national holiday in 2024, years after
    // most of the rest of the list was settled.
    month: 11,
    day: 20,
    name: "Dia Nacional de Zumbi e da Consciência Negra",
    source: "Lei 14.759/2023",
    sinceYear: 2024,
  },
  {
    month: 12,
    day: 25,
    name: "Natal",
    source: "Lei 662/1949, art. 1º",
    sinceYear: 1949,
  },
];

/**
 * Why Carnaval and Corpus Christi are recorded as `optional` and therefore
 * do **not** stop a deadline clock.
 *
 * Neither is a national holiday by federal law. Both are *ponto
 * facultativo*: the Ministério da Gestão publishes an annual portaria
 * suspending the federal executive's own expediente, which binds federal
 * bodies and nobody else. The counterpart in every deadline this system
 * computes is a private company — a telecom's SAC under Decreto
 * 11.034/2022, a card issuer, an operator answering through
 * consumidor.gov.br — and none of them has its legal obligation suspended
 * because a federal portaria gave federal staff the day off.
 *
 * The consequence of getting this wrong runs one way. Treating a working
 * day as a holiday pushes the deadline later, so the escalation the person
 * is being told to make happens after a date this system asserted in
 * writing and the company can show was not the legal one. The document
 * says "o prazo venceu em X"; if X is late, X is disputable, and the
 * dispute is about our arithmetic rather than about their charge.
 *
 * Sexta-feira Santa stops the clock, but it is not statutory and is not
 * labelled as one. Lei 9.093/1995 art. 2º makes it a *municipal* religious
 * holiday: up to four days of guard declared by municipal law, with a
 * Sexta-Feira da Paixão named in the statute as one of them. So there is no
 * federal law putting it on the national calendar, and calling it
 * `statutory` would be a false claim in a product whose documents cite law
 * at companies.
 *
 * It is counted anyway, on its real basis rather than a borrowed one: it is
 * declared in practically every município and it is a day with no banking
 * expediente anywhere in the country, which is the calendar a private
 * deadline is measured against in practice. `religious_municipal` records
 * exactly that - counted, and counted for a reason that is not Lei
 * 662/1949's.
 *
 * Carnaval Monday is deliberately absent. It is facultativo like the
 * Tuesday, so recording it would change no deadline; the Tuesday is here
 * only because it is the one the law and the plan name.
 */
const MOVEABLE_HOLIDAYS: ReadonlyArray<{
  name: string;
  offsetFromEaster: number;
  observance: HolidayObservance;
  source: string;
}> = [
  {
    name: "Carnaval",
    offsetFromEaster: -47,
    observance: "optional",
    source: "Ponto facultativo federal (portaria anual); não é feriado por lei federal",
  },
  {
    name: "Sexta-feira Santa",
    offsetFromEaster: -2,
    observance: "religious_municipal",
    source:
      "Lei 9.093/1995, art. 2º - feriado religioso de lei municipal, máximo de quatro, "
      + "a Sexta-Feira da Paixão nominalmente incluída; declarada em praticamente todo "
      + "município e dia sem expediente bancário nacional",
  },
  {
    name: "Corpus Christi",
    offsetFromEaster: 60,
    observance: "optional",
    source: "Ponto facultativo federal (portaria anual); não é feriado por lei federal",
  },
];

/**
 * Every national date in a year, moveable and fixed, sorted ascending.
 *
 * Includes the `optional` ones — the calendar's job is to record what is
 * true, and the policy about which of them stop a clock belongs to
 * `isBusinessDay` below, where it is one readable line instead of an
 * omission nobody can see.
 */
export function nationalHolidays(year: number): NationalHoliday[] {
  assertYearInRange(year);

  const easter = easterSunday(year);

  const moveable: NationalHoliday[] = MOVEABLE_HOLIDAYS.map((holiday) => ({
    date: addCivilDays(easter, holiday.offsetFromEaster),
    name: holiday.name,
    observance: holiday.observance,
    source: holiday.source,
  }));

  const fixed: NationalHoliday[] = FIXED_HOLIDAYS.filter(
    (holiday) => year >= holiday.sinceYear,
  ).map((holiday) => ({
    date: format(year, holiday.month, holiday.day),
    name: holiday.name,
    observance: "statutory" as const,
    source: holiday.source,
  }));

  return [...moveable, ...fixed].sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Whether a civil date is one the counterpart in a consumer dispute is
 * expected to be working — the unit every business-day deadline counts in.
 *
 * Not cached. A ten-day count builds this list a dozen times, which is
 * nothing next to the round trip that fetched the case, and a cache here
 * would be module state in a package whose whole contract is purity.
 */
export function isBusinessDay(date: CivilDate): boolean {
  const dayOfWeek = civilDayOfWeek(date);
  if (dayOfWeek === SATURDAY || dayOfWeek === SUNDAY) return false;

  const year = Number(date.slice(0, 4));
  return !nationalHolidays(year).some(
    (holiday) => holiday.date === date && holiday.observance !== "optional",
  );
}
