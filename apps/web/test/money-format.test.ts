import { describe, expect, it } from "vitest";
import { formatCentsBRL } from "@pentefino/core";

/**
 * The exact pt-BR money strings every `apps/web` surface renders - the card
 * image, the public `/l/[token]` page and the authenticated `/laudo/[id]`
 * report all format through this one function (enforced by
 * `test/invariants/money-format.spec.ts`), so pinning it here pins all three.
 *
 * These are the three cases `apps/web`'s three private copies of this
 * function were never asked about: every fixture in this suite used an
 * amount under R$ 1.000,00 and none used a credit line, which is precisely
 * how the same split went unnoticed between `@pentefino/core`'s dossier and
 * `apps/jobs`'s PDF renderer until E5 task 7 - there the two copies had
 * already drifted (`R$ 1189,90` vs `R$ 1.189,90`, `R$ -1,50` vs `-R$ 1,50`)
 * and the fixtures still could not tell.
 */
describe("formatCentsBRL, as apps/web renders money", () => {
  it("separates thousands with a dot, at and above R$ 1.000,00", () => {
    expect(formatCentsBRL(100000)).toBe("R$ 1.000,00");
    expect(formatCentsBRL(118990)).toBe("R$ 1.189,90");
    expect(formatCentsBRL(1234567)).toBe("R$ 12.345,67");
  });

  it("puts a credit line's minus sign before the currency symbol", () => {
    expect(formatCentsBRL(-150)).toBe("-R$ 1,50");
    expect(formatCentsBRL(-118990)).toBe("-R$ 1.189,90");
  });

  it("renders zero with both centavos digits and no sign", () => {
    expect(formatCentsBRL(0)).toBe("R$ 0,00");
  });

  it("separates the currency symbol from the digits with a plain ASCII space", () => {
    // PRD §10's RF-128 acceptance example is written "R$ 51,60"; pt-BR's ICU
    // output puts U+00A0 there instead, which is why this never goes through
    // `Intl`. A card image renders the difference visibly.
    expect(formatCentsBRL(5160)).toBe("R$ 51,60");
    expect(formatCentsBRL(100000)).not.toContain(" ");
  });
});
