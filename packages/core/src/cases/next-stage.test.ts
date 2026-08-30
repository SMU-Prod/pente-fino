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

  it("names E5 and includes the stage, event and category that were passed", () => {
    expect(() =>
      nextStage(
        { stage: "sac", category: "telecom", hasProtocol: true },
        playbook,
        { type: "deadline_expired", at: new Date("2026-08-30T00:00:00Z") },
      ),
    ).toThrow(/stage=sac.*event=deadline_expired.*category=telecom.*E5/is);
  });
});
