import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * The package's public entry point is a barrel of re-exports, and nothing
 * else in the suite imports through it — every other test reaches into a
 * module directly. A merge that broke the barrel therefore left the whole
 * suite green, which is how conflict markers once survived a commit here.
 *
 * This file imports the barrel, so a broken entry point fails a test rather
 * than only failing whoever consumes the package next.
 */
describe("the public entry point", () => {
  it("loads", () => {
    expect(core).toBeTypeOf("object");
  });

  it("exports every symbol a consumer outside the package relies on", () => {
    const expected = [
      "newId",
      "newPublicToken",
      "EVENTS",
      "InvoiceCanonical",
      "CATEGORIES",
      "ContestDocument",
      "STAGES",
      "RULE_KINDS",
      "normalizeDescription",
      "validateInvoice",
      "maskCanonical",
      "maskText",
      "containsPii",
      "runRules",
      "nextStage",
      "computeDeadline",
      "toCivilDate",
      "nationalHolidays",
      "easterSunday",
      "isBusinessDay",
      "HOLIDAY_CALENDAR_VERSION",
      "pairInvoiceItems",
      "extractionQuality",
      "VISION_THRESHOLD",
      "detectIssuer",
      "CNPJ_SHAPE_SOURCE",
      "sniffMimeType",
      "MAX_PAGES",
    ];
    const missing = expected.filter((name) => !(name in core));
    expect(missing).toEqual([]);
  });

  it("exports nothing that is undefined, which is what a broken re-export looks like", () => {
    const undefinedExports = Object.entries(core)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    expect(undefinedExports).toEqual([]);
  });
});
