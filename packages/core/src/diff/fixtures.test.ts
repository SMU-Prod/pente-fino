import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InvoiceCanonical } from "../invoice/canonical.js";
import { classifyContestedItems, type ContestedItem } from "./outcome.js";

/**
 * §18's gate: "Fixtures de par de faturas passam." Loads the RF-201
 * fixtures committed at fixtures/synthetic/diff/, following the same
 * relative-loader pattern apps/jobs/test/ingest.test.ts already uses for
 * its own committed PDF fixtures - four `../` from
 * packages/core/src/diff/ reaches the repo root.
 */
function loadFixture(name: string): InvoiceCanonical {
  const path = fileURLToPath(new URL(`../../../../fixtures/synthetic/diff/${name}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return InvoiceCanonical.parse(raw);
}

const FIXTURE_NAMES = [
  "disappeared-n",
  "disappeared-n1",
  "reversal-equal-n",
  "reversal-equal-n1",
  "reversal-double-n",
  "reversal-double-n1",
  "still-charged-n",
  "still-charged-n1",
  "recurring-credit-n",
  "recurring-credit-n1",
  "reappeared-n2",
];

describe("diff pair fixtures (§18 gate)", () => {
  // Every fixture must parse with InvoiceCanonical.parse(...) on its own, so
  // a malformed fixture fails here, not three layers up in a verdict test.
  it.each(FIXTURE_NAMES)("%s parses as a valid InvoiceCanonical", (name) => {
    expect(() => loadFixture(name)).not.toThrow();
  });

  it("disappeared: the contested SVA line absent on N+1 resolves to disappeared", () => {
    const previous = loadFixture("disappeared-n");
    const current = loadFixture("disappeared-n1");
    const contested: ContestedItem[] = [
      { findingId: "fin_disappeared", description: "Skeelo Premium", amountCents: 1990 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions[0]?.verdict).toBe("disappeared");
    expect(outcome.resolutions[0]?.recoveredCents).toBe(1990);
  });

  it("reversal-equal: a credit exactly matching the contested amount resolves to reversed", () => {
    const previous = loadFixture("reversal-equal-n");
    const current = loadFixture("reversal-equal-n1");
    const contested: ContestedItem[] = [{ findingId: "fin_reversal_equal", description: "GoRead", amountCents: 1500 }];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions[0]?.verdict).toBe("reversed");
    expect(outcome.resolutions[0]?.recoveredCents).toBe(1500);
  });

  it("reversal-double: a credit for double the contested amount resolves to reversed", () => {
    const previous = loadFixture("reversal-double-n");
    const current = loadFixture("reversal-double-n1");
    const contested: ContestedItem[] = [
      { findingId: "fin_reversal_double", description: "Hube Jornais", amountCents: 995 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions[0]?.verdict).toBe("reversed");
    expect(outcome.resolutions[0]?.recoveredCents).toBe(1990);
  });

  it("still-charged: the contested line still present with no matching credit resolves to still_charged", () => {
    const previous = loadFixture("still-charged-n");
    const current = loadFixture("still-charged-n1");
    const contested: ContestedItem[] = [
      { findingId: "fin_still_charged", description: "NBA Básico", amountCents: 1990 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions[0]?.verdict).toBe("still_charged");
    expect(outcome.resolutions[0]?.recoveredCents).toBe(0);
  });

  it("recurring-credit: a credit that already existed on the previous invoice is not a reversal", () => {
    const previous = loadFixture("recurring-credit-n");
    const current = loadFixture("recurring-credit-n1");
    const contested: ContestedItem[] = [
      { findingId: "fin_recurring_credit", description: "Skeelo Premium", amountCents: 1990 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions[0]?.verdict).toBe("still_charged");
    expect(outcome.resolutions[0]?.recoveredCents).toBe(0);
  });
});
