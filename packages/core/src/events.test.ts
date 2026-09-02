import { describe, expect, it } from "vitest";
import { EVENTS } from "./events.js";

describe("EVENTS", () => {
  it("carries every event named in PRD §15.1, plus the ingest, expiry and finding terminals Tasks 13, 9 and 8 (E1/E2) added, plus invoice_processing_started (Task 2, E3), RF-187's dossier pair, RF-184's response_received and RF-186's case_stalled (Tasks 7, 5 and 3, E5), plus RF-185's case_viewed (Task 6, E5)", () => {
    expect(EVENTS).toHaveLength(38);
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

  it("names both outcomes of RF-110's daily expiry job", () => {
    expect(EVENTS).toContain("invoice_file_expired");
    expect(EVENTS).toContain("invoice_file_expiry_failed");
  });

  it("names the rule-firing event RF-302's rule_metrics job and RF-126/RF-127's promotion/pause read", () => {
    expect(EVENTS).toContain("finding_created");
  });

  it("names both outcomes of RF-187's jec_ready dossier job", () => {
    expect(EVENTS).toContain("dossier_generated");
    expect(EVENTS).toContain("dossier_generation_failed");
  });

  // §9.1's machine answers to a `response_received` StageEvent — it is what
  // clears the wait — so A3 needs a name for it, or the one thing that ends
  // a wait without a deadline having expired leaves no trace at all.
  it("names both directions of the channel conversation §9.1 tracks", () => {
    expect(EVENTS).toContain("protocol_entered");
    expect(EVENTS).toContain("response_received");
  });

  it("names RF-186's stall, the one §9.1 sub-state that cannot be a cases.stage value", () => {
    expect(EVENTS).toContain("case_stalled");
  });

  it("names the case screen being opened, the durable fact RF-185's reminder suppression reads (Task 6, E5)", () => {
    expect(EVENTS).toContain("case_viewed");
  });
});
