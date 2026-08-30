import { describe, expect, it } from "vitest";
import { nextStage } from "./next-stage.js";
import type { Playbook } from "./playbook.js";

const playbook: Playbook = { stages: [] };

describe("nextStage", () => {
  it("throws on an unmapped combination rather than guessing a stage", () => {
    expect(() =>
      nextStage(
        { stage: "sac", category: "telecom", hasProtocol: true },
        playbook,
        { type: "deadline_expired", at: new Date("2026-08-30T00:00:00Z") },
      ),
    ).toThrow(/not mapped/i);
  });

  it("names E5 and includes the stage, event, category and hasProtocol that were passed", () => {
    expect(() =>
      nextStage(
        { stage: "sac", category: "telecom", hasProtocol: true },
        playbook,
        { type: "deadline_expired", at: new Date("2026-08-30T00:00:00Z") },
      ),
    ).toThrow(/stage=sac.*event=deadline_expired.*category=telecom.*hasProtocol=true.*E5/is);
  });

  it("accepts the RF-203 reopening event (item_reappeared) in its type surface", () => {
    // §9.1 has no mapped transition yet (E5) — this only proves the event
    // vocabulary can express "contested item came back on invoice N+2"
    // without a type error, per RF-203.
    expect(() =>
      nextStage(
        { stage: "closed", category: "energy", hasProtocol: false },
        playbook,
        { type: "item_reappeared", at: new Date("2026-08-30T00:00:00Z") },
      ),
    ).toThrow(/event=item_reappeared/);
  });
});
