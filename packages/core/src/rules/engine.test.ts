import { describe, expect, it } from "vitest";
import { runRules } from "./engine.js";
import type { InvoiceCanonical } from "../invoice/canonical.js";

const invoice = {
  issuer: { name: "Claro Móvel", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
  extraction: { confidence: 0.9, warnings: [] },
} as InvoiceCanonical;

const noReferences = { tariffs: [], flags: [] };

describe("runRules", () => {
  it("returns no findings when no rule is active", () => {
    expect(
      runRules({ invoice, previous: null, rules: [], answers: {}, references: noReferences }),
    ).toEqual([]);
  });

  it("is pure: the same input always yields the same output (RF-120)", () => {
    const input = { invoice, previous: null, rules: [], answers: {}, references: noReferences };
    expect(runRules(input)).toEqual(runRules(input));
  });

  it("does not mutate the invoice it is given", () => {
    const snapshot = JSON.stringify(invoice);
    runRules({ invoice, previous: null, rules: [], answers: {}, references: noReferences });
    expect(JSON.stringify(invoice)).toBe(snapshot);
  });

  it("throws naming E2 and the unevaluated rules when a non-empty rule set arrives", () => {
    expect(() =>
      runRules({
        invoice,
        previous: null,
        rules: [
          {
            slug: "cobranca-dobrada",
            version: 1,
            spec: { kind: "threshold", expr: "total", operator: ">", value: 0 },
            confidenceBase: 0.8,
            shadow: false,
            legalBasis: [{ law: "CDC", article: "42", effect: "dobro" }],
            issuerId: null,
          },
        ],
        answers: {},
        references: noReferences,
      }),
    ).toThrow(/E2.*cobranca-dobrada@1/s);
  });
});
