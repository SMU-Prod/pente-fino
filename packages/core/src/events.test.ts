import { describe, expect, it } from "vitest";
import { EVENTS } from "./events.js";

describe("EVENTS", () => {
  it("carries every event named in PRD §15.1, plus the two ingest terminals Task 13 added", () => {
    expect(EVENTS).toHaveLength(29);
  });

  it("has no duplicates, because names are a contract", () => {
    expect(new Set(EVENTS).size).toBe(EVENTS.length);
  });

  it("contains the whole main funnel of §15.2", () => {
    for (const step of [
      "invoice_uploaded",
      "report_viewed",
      "contest_generated",
      "contest_marked_sent",
      "protocol_entered",
      "outcome_confirmed",
    ]) {
      expect(EVENTS).toContain(step);
    }
  });

  it("names both terminal transitions of the §9.2 invoice state machine", () => {
    expect(EVENTS).toContain("invoice_analyzed");
    expect(EVENTS).toContain("invoice_failed");
  });
});
