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
      "STAGE_EVENT_TYPES",
      "PROTOCOL_WINDOW_DAYS",
      "TELECOM_PLAYBOOK_V1",
      "pairInvoiceItems",
      "trigramSimilarity",
      "TRIGRAM_THRESHOLD",
      // RF-201 (E6 Task 2): the diff job that will call this next lives
      // outside this package, the same way RF-200's `pairInvoiceItems` does.
      "classifyContestedItems",
      "extractionQuality",
      "VISION_THRESHOLD",
      "detectIssuer",
      "CNPJ_SHAPE_SOURCE",
      "sniffMimeType",
      "MAX_PAGES",
      // RF-187: `apps/jobs` builds the dossier through the barrel, lints
      // `DOSSIER_FIXED_STRINGS` against §14.3, and formats the money and
      // dates it prints with the same helpers this package uses — so a
      // dropped re-export of any of these is a broken consumer, not a
      // cosmetic barrel edit.
      "buildDossier",
      "DOSSIER_FIXED_STRINGS",
      "formatCentsBRL",
      "formatUtcDate",
      "formatIsoDateOrUnknown",
      // RF-182: the protocol route and the contest generator both live
      // outside this package and both reach these through the barrel —
      // `collectExpiredDeadlines` turns a case's own rows into
      // `deadlinesExpired`, `expiredDeadlineSentence` is the sentence
      // RF-182's acceptance looks for.
      "assembleContest",
      "collectExpiredDeadlines",
      "expiredDeadlineSentence",
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
