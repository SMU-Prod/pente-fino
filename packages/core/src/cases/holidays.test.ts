import { describe, expect, it } from "vitest";
import {
  addCivilDays,
  civilDayOfWeek,
  easterSunday,
  HOLIDAY_CALENDAR_FIRST_YEAR,
  HOLIDAY_CALENDAR_LAST_YEAR,
  HOLIDAY_CALENDAR_VERSION,
  isBusinessDay,
  nationalHolidays,
} from "./holidays.js";

const SUNDAY = 0;
const TUESDAY = 2;
const THURSDAY = 4;
const FRIDAY = 5;

function names(year: number): string[] {
  return nationalHolidays(year).map((h) => h.name);
}

function dates(year: number): string[] {
  return nationalHolidays(year).map((h) => h.date);
}

describe("civil date primitives", () => {
  it("rejects anything that is not a YYYY-MM-DD civil date", () => {
    expect(() => civilDayOfWeek("2026-5-4")).toThrow(/civil date/i);
    expect(() => civilDayOfWeek("04/05/2026")).toThrow(/civil date/i);
    expect(() => civilDayOfWeek("")).toThrow(/civil date/i);
  });

  it("rejects a well-shaped date that does not exist", () => {
    // The trap: `Date.UTC(2026, 1, 30)` silently rolls over to 2 March and
    // would answer confidently about a day that never happened.
    expect(() => civilDayOfWeek("2026-02-30")).toThrow(/civil date/i);
    expect(() => civilDayOfWeek("2026-13-01")).toThrow(/civil date/i);
    expect(() => civilDayOfWeek("2025-02-29")).toThrow(/civil date/i);
  });

  it("accepts 29 February in a leap year", () => {
    expect(() => civilDayOfWeek("2024-02-29")).not.toThrow();
  });

  it("reads the day of the week, Sunday being 0", () => {
    expect(civilDayOfWeek("2026-04-05")).toBe(SUNDAY); // Easter 2026
    expect(civilDayOfWeek("2026-04-30")).toBe(THURSDAY);
    expect(civilDayOfWeek("2026-05-01")).toBe(FRIDAY);
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addCivilDays("2026-04-30", 1)).toBe("2026-05-01");
    expect(addCivilDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCivilDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addCivilDays("2025-02-28", 1)).toBe("2025-03-01");
    expect(addCivilDays("2026-05-04", 7)).toBe("2026-05-11");
    expect(addCivilDays("2026-05-04", 0)).toBe("2026-05-04");
    expect(addCivilDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("the computus", () => {
  // Independently known Easter Sundays. 2038 is the latest date the
  // Gregorian computus can produce and 2049 is a year where the algorithm's
  // rare `m` correction term is non-zero, so both exercise branches the
  // ordinary years never reach.
  const KNOWN: Array<[number, string]> = [
    [2000, "2000-04-23"],
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2038, "2038-04-25"],
    [2049, "2049-04-18"],
  ];

  it.each(KNOWN)("puts Easter %i on %s", (year, date) => {
    expect(easterSunday(year)).toBe(date);
  });

  it("always lands on a Sunday, for every year the calendar covers", () => {
    const notSunday: string[] = [];
    for (let year = HOLIDAY_CALENDAR_FIRST_YEAR; year <= HOLIDAY_CALENDAR_LAST_YEAR; year += 1) {
      const easter = easterSunday(year);
      if (civilDayOfWeek(easter) !== SUNDAY) notSunday.push(easter);
    }
    expect(notSunday).toEqual([]);
  });

  it("always lands between 22 March and 25 April, which bounds the algorithm", () => {
    const outOfRange: string[] = [];
    for (let year = HOLIDAY_CALENDAR_FIRST_YEAR; year <= HOLIDAY_CALENDAR_LAST_YEAR; year += 1) {
      const easter = easterSunday(year);
      const monthDay = easter.slice(5);
      if (monthDay < "03-22" || monthDay > "04-25") outOfRange.push(easter);
    }
    expect(outOfRange).toEqual([]);
  });

  it("refuses a year outside the range the calendar is sourced for", () => {
    expect(() => easterSunday(HOLIDAY_CALENDAR_FIRST_YEAR - 1)).toThrow(RangeError);
    expect(() => easterSunday(HOLIDAY_CALENDAR_LAST_YEAR + 1)).toThrow(RangeError);
    expect(() => easterSunday(2026.5)).toThrow(RangeError);
    expect(() => easterSunday(Number.NaN)).toThrow(RangeError);
  });
});

describe("the national holiday calendar", () => {
  it("derives the moveable holidays from Easter", () => {
    // Easter 2026 is 5 April.
    const calendar = nationalHolidays(2026);
    const byName = new Map(calendar.map((h) => [h.name, h.date]));
    expect(byName.get("Sexta-feira Santa")).toBe("2026-04-03"); // Easter - 2
    expect(byName.get("Carnaval")).toBe("2026-02-17"); // Easter - 47
    expect(byName.get("Corpus Christi")).toBe("2026-06-04"); // Easter + 60
  });

  it("keeps every moveable holiday on the weekday it is defined to fall on", () => {
    const wrong: string[] = [];
    for (let year = HOLIDAY_CALENDAR_FIRST_YEAR; year <= HOLIDAY_CALENDAR_LAST_YEAR; year += 1) {
      const byName = new Map(nationalHolidays(year).map((h) => [h.name, h.date]));
      const santa = byName.get("Sexta-feira Santa") as string;
      const carnaval = byName.get("Carnaval") as string;
      const corpus = byName.get("Corpus Christi") as string;
      if (civilDayOfWeek(santa) !== FRIDAY) wrong.push(santa);
      if (civilDayOfWeek(carnaval) !== TUESDAY) wrong.push(carnaval);
      if (civilDayOfWeek(corpus) !== THURSDAY) wrong.push(corpus);
    }
    expect(wrong).toEqual([]);
  });

  it("carries the nine fixed national dates for a current year", () => {
    expect(dates(2026)).toEqual(
      expect.arrayContaining([
        "2026-01-01",
        "2026-04-21",
        "2026-05-01",
        "2026-09-07",
        "2026-10-12",
        "2026-11-02",
        "2026-11-15",
        "2026-11-20",
        "2026-12-25",
      ]),
    );
  });

  it("is sorted, with no date appearing twice", () => {
    const all = dates(2026);
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("records where every entry comes from", () => {
    const sourceless = nationalHolidays(2026).filter((h) => h.source.trim() === "");
    expect(sourceless).toEqual([]);
  });

  it("is versioned, so a change of law has a place to be recorded", () => {
    expect(HOLIDAY_CALENDAR_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  describe("dates that entered or left the calendar by law", () => {
    it("adds 20 de novembro only from 2024, when Lei 14.759/2023 took effect", () => {
      expect(dates(2023)).not.toContain("2023-11-20");
      expect(dates(2024)).toContain("2024-11-20");
      const zumbi = nationalHolidays(2024).find((h) => h.date === "2024-11-20");
      expect(zumbi?.source).toContain("14.759");
    });

    it("adds 12 de outubro only from 1980, when Lei 6.802/1980 created it", () => {
      expect(dates(1979)).not.toContain("1979-10-12");
      expect(dates(1980)).toContain("1980-10-12");
    });

    it("adds 2 de novembro only from 2002, when Lei 10.607/2002 wrote it into Lei 662/1949", () => {
      expect(dates(2001)).not.toContain("2001-11-02");
      expect(dates(2002)).toContain("2002-11-02");
    });
  });

  describe("statutory versus optional", () => {
    it("marks Carnaval and Corpus Christi optional, because nationally they are ponto facultativo", () => {
      const calendar = nationalHolidays(2026);
      const optional = calendar.filter((h) => h.observance === "optional").map((h) => h.name);
      expect(optional.sort()).toEqual(["Carnaval", "Corpus Christi"]);
    });

    // Lei 9.093/1995 art. 2º makes Sexta-feira Santa a *municipal*
    // religious holiday, not a national one - no federal law puts it on this
    // calendar. It stops the clock all the same (declared in practically
    // every município, no banking expediente anywhere), so the label has to
    // say both things at once: counted, and counted on a different basis
    // from Lei 662/1949's dates. Calling it `statutory` would be a false
    // claim about the law in a product that cites law at companies.
    it("marks Sexta-feira Santa religious_municipal, not statutory", () => {
      const santa = nationalHolidays(2026).find((h) => h.name === "Sexta-feira Santa");
      expect(santa?.observance).toBe("religious_municipal");
      expect(santa?.source).toContain("Lei 9.093/1995");
    });

    it("still counts Sexta-feira Santa as a non-business day", () => {
      // 2026-04-03. The classification changed; the arithmetic must not.
      expect(isBusinessDay("2026-04-03")).toBe(false);
    });

    it("marks every fixed date statutory", () => {
      const notStatutory = nationalHolidays(2026)
        .filter((h) => h.observance !== "statutory")
        .filter((h) => !["Carnaval", "Corpus Christi", "Sexta-feira Santa"].includes(h.name));
      expect(notStatutory).toEqual([]);
    });
  });

  it("refuses a year outside the range it is sourced for", () => {
    expect(() => nationalHolidays(HOLIDAY_CALENDAR_FIRST_YEAR - 1)).toThrow(RangeError);
    expect(() => nationalHolidays(HOLIDAY_CALENDAR_LAST_YEAR + 1)).toThrow(RangeError);
  });
});

describe("isBusinessDay", () => {
  it("is false on a Saturday and a Sunday", () => {
    expect(isBusinessDay("2026-05-02")).toBe(false);
    expect(isBusinessDay("2026-05-03")).toBe(false);
  });

  it("is true on an ordinary weekday", () => {
    expect(isBusinessDay("2026-05-04")).toBe(true);
    expect(isBusinessDay("2026-04-30")).toBe(true);
  });

  it("is false on a statutory holiday that falls on a weekday", () => {
    expect(isBusinessDay("2026-05-01")).toBe(false); // Dia do Trabalho, a Friday
    expect(isBusinessDay("2026-04-03")).toBe(false); // Sexta-feira Santa
    expect(isBusinessDay("2026-12-25")).toBe(false); // Natal, a Friday
  });

  it("is TRUE on Carnaval and Corpus Christi, the decision this calendar makes", () => {
    // Neither is a statutory national holiday; both are ponto facultativo,
    // which binds the federal administration and not the company a
    // consumer is waiting on. Counting them would push every deadline a
    // day or two late. See holidays.ts for the reasoning in full.
    expect(isBusinessDay("2026-02-17")).toBe(true); // Carnaval
    expect(isBusinessDay("2026-06-04")).toBe(true); // Corpus Christi
  });

  it("is false on 20 de novembro from 2024 and true on it in 2023", () => {
    expect(isBusinessDay("2023-11-20")).toBe(true); // a Monday, before the law
    expect(isBusinessDay("2024-11-20")).toBe(false); // a Wednesday, after it
  });
});
