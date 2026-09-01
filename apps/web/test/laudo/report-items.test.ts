import { describe, expect, it } from "vitest";
import {
  confidenceLabel, isPendingQuestion, removeById, splitReportItems, type ReportItem,
} from "../../app/laudo/[id]/report-items.js";

function finding(overrides: Partial<ReportItem> = {}): ReportItem {
  return {
    id: "fnd_1",
    invoiceId: "inv_1",
    itemId: null,
    ruleId: "rul_1",
    ruleVersion: 1,
    confidence: 0.7,
    evidence: ["Cobrança repetida no mesmo ciclo."],
    amountCents: 1500,
    doubledCents: null,
    shadow: false,
    status: "open",
    createdAt: new Date(),
    updatedAt: new Date(),
    band: "verify",
    ...overrides,
  } as ReportItem;
}

function aggregate(overrides: Partial<ReportItem> = {}): ReportItem {
  return {
    id: "agg:Serviços digitais",
    aggregate: true,
    itemId: null,
    confidence: 0.9,
    band: "likely",
    evidence: ["R$ 51,60 em 5 serviços digitais"],
    amountCents: 5160,
    doubledCents: null,
    ...overrides,
  } as ReportItem;
}

describe("isPendingQuestion", () => {
  it("is true for a non-aggregate finding banded as a question", () => {
    expect(isPendingQuestion(finding({ band: "question" }))).toBe(true);
  });

  it("is false for a verify- or likely-band finding", () => {
    expect(isPendingQuestion(finding({ band: "verify" }))).toBe(false);
    expect(isPendingQuestion(finding({ band: "likely" }))).toBe(false);
  });

  it("is false for an aggregate even if its band happens to be question", () => {
    // Aggregates carry a synthetic id (`agg:<section>`) that does not
    // correspond to a real findings row - POST /api/findings/:id/feedback
    // would 404 on it. An aggregate can never be treated as answerable.
    expect(isPendingQuestion(aggregate({ band: "question" }))).toBe(false);
  });
});

describe("splitReportItems", () => {
  it("separates pending questions from everything else, preserving order within each group", () => {
    const q1 = finding({ id: "fnd_q1", band: "question" });
    const agg = aggregate();
    const f1 = finding({ id: "fnd_f1", band: "likely" });
    const q2 = finding({ id: "fnd_q2", band: "question" });

    const { regular, questions } = splitReportItems([q1, agg, f1, q2]);

    expect(questions.map((i) => i.id)).toEqual(["fnd_q1", "fnd_q2"]);
    expect(regular.map((i) => i.id)).toEqual(["agg:Serviços digitais", "fnd_f1"]);
  });

  it("returns empty arrays for an empty report", () => {
    expect(splitReportItems([])).toEqual({ regular: [], questions: [] });
  });
});

describe("removeById", () => {
  it("removes only the matching item", () => {
    const items = [finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" })];
    expect(removeById(items, "b").map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("is a no-op when the id is not present", () => {
    const items = [finding({ id: "a" })];
    expect(removeById(items, "missing")).toEqual(items);
  });
});

describe("confidenceLabel", () => {
  it("labels the 0,55-0,8 band as 'Verificar', in words per RF-124/§13.3", () => {
    expect(confidenceLabel("verify")).toBe("Verificar");
  });

  it("labels the >0,8 band with RF-124's exact phrase", () => {
    expect(confidenceLabel("likely")).toBe("Provável cobrança a contestar");
  });

  it("has no confidence label for a question - it is a question, not a confidence level", () => {
    expect(confidenceLabel("question")).toBeNull();
  });
});
