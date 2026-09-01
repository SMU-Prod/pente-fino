import { describe, expect, it } from "vitest";
import { delta } from "./index.js";
import type { ActiveRule } from "../engine.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";
import type { EvaluationContext } from "./types.js";

const noReferences = { tariffs: [], flags: [] };

function invoice(overrides: Partial<InvoiceCanonical> = {}): InvoiceCanonical {
  return {
    issuer: { name: "Claro Móvel", category: "telecom" },
    period: { start: "2026-08-01", end: "2026-08-31" },
    dueDate: "2026-09-10",
    totalCents: 10000,
    sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
    extraction: { confidence: 0.9, warnings: [] },
    ...overrides,
  } as InvoiceCanonical;
}

function rule(options: {
  field: "item_present" | "amount" | "section_total";
  changeAtLeastPct?: number;
}): ActiveRule {
  return {
    slug: "delta-rule",
    version: 1,
    spec:
      options.changeAtLeastPct === undefined
        ? { kind: "delta", comparedTo: "previous_invoice", field: options.field }
        : {
            kind: "delta",
            comparedTo: "previous_invoice",
            field: options.field,
            changeAtLeastPct: options.changeAtLeastPct,
          },
    confidenceBase: 0.7,
    shadow: false,
    legalBasis: [{ law: "CDC", article: "39", effect: "vedada" }],
    issuerId: null,
    category: "telecom",
  };
}

function ctx(current: InvoiceCanonical, previous: InvoiceCanonical | null): EvaluationContext {
  return { invoice: current, previous, references: noReferences, answers: {} };
}

describe("delta - guards", () => {
  it("returns nothing when called with a rule of a different kind (defensive dispatch guard)", () => {
    const previous = invoice();
    const current = invoice();
    const notDelta: ActiveRule = {
      slug: "not-delta",
      version: 1,
      spec: { kind: "threshold", expr: "total", operator: ">", value: 0 },
      confidenceBase: 0.5,
      shadow: false,
      legalBasis: [{ law: "CDC", article: "39", effect: "vedada" }],
      issuerId: null,
      category: "telecom",
    };
    expect(delta(notDelta, ctx(current, previous))).toEqual([]);
  });
});

describe("delta - no previous invoice", () => {
  it("produces nothing when there is no previous invoice to compare against, for any field", () => {
    const current = invoice();
    expect(delta(rule({ field: "item_present" }), ctx(current, null))).toEqual([]);
    expect(delta(rule({ field: "amount" }), ctx(current, null))).toEqual([]);
    expect(delta(rule({ field: "section_total" }), ctx(current, null))).toEqual([]);
  });
});

describe("delta - item_present", () => {
  it("flags an item whose section did not exist on the previous invoice (positive)", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano Internet", amountCents: 10000 }] }],
    });
    const current = invoice({
      sections: [
        { name: "Serviços", items: [{ description: "Plano Internet 08/2026", amountCents: 10000 }] },
        { name: "Serviços digitais", items: [{ description: "Netflix Premium", amountCents: 2990 }] },
      ],
    });
    const findings = delta(rule({ field: "item_present" }), ctx(current, previous));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(2990);
    expect(findings[0]?.evidence[0]).toMatch(/Netflix Premium/);
    expect(findings[0]?.legalBasis).toEqual(rule({ field: "item_present" }).legalBasis);
  });

  it("does not flag an item whose normalised description already matched last cycle (negative)", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano Internet 07/2026", amountCents: 10000 }] }],
    });
    const current = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano Internet 08/2026", amountCents: 10000 }] }],
    });
    expect(delta(rule({ field: "item_present" }), ctx(current, previous))).toEqual([]);
  });

  it(
    "treats a numeric-only difference as unchanged rather than new, because normalizeDescription " +
      "drops purely numeric tokens and cannot tell a recurring line from a distinct one-off charge " +
      "that merely collides in shape - see delta.ts for the reasoning",
    () => {
      const previous = invoice({
        sections: [{ name: "Serviços", items: [{ description: "Protocolo 40041", amountCents: 500 }] }],
      });
      const current = invoice({
        sections: [{ name: "Serviços", items: [{ description: "Protocolo 40042", amountCents: 500 }] }],
      });
      expect(delta(rule({ field: "item_present" }), ctx(current, previous))).toEqual([]);
    },
  );
});

describe("delta - amount", () => {
  it("flags an item whose amount increased at least changeAtLeastPct (positive)", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
    });
    const current = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 12000 }] }],
    });
    const findings = delta(rule({ field: "amount", changeAtLeastPct: 10 }), ctx(current, previous));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(2000);
  });

  it("does not flag an increase below changeAtLeastPct (negative)", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
    });
    const current = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10500 }] }],
    });
    expect(delta(rule({ field: "amount", changeAtLeastPct: 10 }), ctx(current, previous))).toEqual([]);
  });

  it("never flags a decrease, however large, since there is nothing to contest", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
    });
    const current = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 1000 }] }],
    });
    expect(delta(rule({ field: "amount" }), ctx(current, previous))).toEqual([]);
  });

  it("skips a group ambiguous on the previous invoice rather than guessing which item paired with which", () => {
    const previous = invoice({
      sections: [
        {
          name: "Serviços",
          items: [
            { description: "Taxa", amountCents: 500 },
            { description: "Taxa", amountCents: 700 },
          ],
        },
      ],
    });
    const current = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Taxa", amountCents: 1000 }] }],
    });
    expect(delta(rule({ field: "amount" }), ctx(current, previous))).toEqual([]);
  });

  it("skips a group ambiguous on the current invoice for the same reason", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Taxa", amountCents: 500 }] }],
    });
    const current = invoice({
      sections: [
        {
          name: "Serviços",
          items: [
            { description: "Taxa", amountCents: 900 },
            { description: "Taxa", amountCents: 950 },
          ],
        },
      ],
    });
    expect(delta(rule({ field: "amount" }), ctx(current, previous))).toEqual([]);
  });

  it("fires on any increase at all when changeAtLeastPct is not given", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
    });
    const current = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10001 }] }],
    });
    const findings = delta(rule({ field: "amount" }), ctx(current, previous));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(1);
  });

  it(
    "fires exactly at the changeAtLeastPct boundary using exact integer arithmetic - " +
      "100->129 cents is a mathematically exact 29% increase, but " +
      "((129-100)/100)*100 as a float evaluates to 28.999999999999996 in JS, " +
      "which would wrongly exclude this boundary case under a naive float comparison",
    () => {
      const previous = invoice({
        sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 100 }] }],
      });
      const current = invoice({
        sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 129 }] }],
      });
      expect(((129 - 100) / 100) * 100).toBeLessThan(29); // documents the float trap this guards against
      const findings = delta(rule({ field: "amount", changeAtLeastPct: 29 }), ctx(current, previous));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.amountCents).toBe(29);
    },
  );
});

describe("delta - section_total", () => {
  it("flags a section whose total increased at least changeAtLeastPct (positive)", () => {
    const previous = invoice({
      sections: [
        {
          name: "Serviços",
          items: [
            { description: "Plano", amountCents: 8000 },
            { description: "Taxa", amountCents: 2000 },
          ],
        },
      ],
    });
    const current = invoice({
      sections: [
        {
          name: "Serviços",
          items: [
            { description: "Plano", amountCents: 9000 },
            { description: "Taxa", amountCents: 3000 },
          ],
        },
      ],
    });
    const findings = delta(rule({ field: "section_total", changeAtLeastPct: 10 }), ctx(current, previous));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(2000);
    expect(findings[0]?.evidence[0]).toMatch(/Serviços/);
  });

  it("does not flag a section absent from one of the two invoices - nothing to compare", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 8000 }] }],
    });
    const current = invoice({
      sections: [
        { name: "Serviços", items: [{ description: "Plano", amountCents: 8000 }] },
        { name: "Serviços digitais", items: [{ description: "Netflix", amountCents: 2990 }] },
      ],
    });
    expect(delta(rule({ field: "section_total" }), ctx(current, previous))).toEqual([]);
  });
});

describe("delta - RF-129", () => {
  it("carries the rule's own evidence and legal basis, never inventing either", () => {
    const previous = invoice({
      sections: [{ name: "Serviços", items: [{ description: "Plano Internet", amountCents: 10000 }] }],
    });
    const current = invoice({
      sections: [
        { name: "Serviços", items: [{ description: "Plano Internet", amountCents: 10000 }] },
        { name: "Serviços digitais", items: [{ description: "Netflix", amountCents: 2990 }] },
      ],
    });
    const activeRule = rule({ field: "item_present" });
    const [finding] = delta(activeRule, ctx(current, previous));
    expect(finding?.evidence.length).toBeGreaterThan(0);
    expect(finding?.legalBasis).toBe(activeRule.legalBasis);
    expect(finding?.ruleSlug).toBe(activeRule.slug);
    expect(finding?.ruleVersion).toBe(activeRule.version);
    expect(finding?.confidence).toBe(activeRule.confidenceBase);
    expect(finding?.shadow).toBe(activeRule.shadow);
  });
});
