import { describe, expect, it } from "vitest";
import { classifyContestedItems, type ContestedItem } from "./outcome.js";
import type { InvoiceCanonical } from "../invoice/canonical.js";

type ItemInput = { description: string; amountCents: number };
type SectionInput = { name: string; items: ItemInput[] };

/**
 * A minimal invoice with the given period and sections. Only the fields
 * `classifyContestedItems` reads vary across tests; the rest is fixed
 * filler that satisfies `InvoiceCanonical`'s shape (mirrors the helper in
 * `./index.test.ts`).
 */
function invoiceWith(period: { start: string; end: string }, sections: SectionInput[]): InvoiceCanonical {
  return {
    issuer: { name: "Vivo", category: "telecom" },
    period,
    dueDate: "2026-08-10",
    totalCents: 10000,
    sections,
    extraction: { confidence: 0.9, warnings: [] },
  } as InvoiceCanonical;
}

describe("classifyContestedItems", () => {
  it("marks a contested item disappeared when it has no pair on the current invoice", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      { name: "Serviços", items: [{ description: "Plano Controle 20GB", amountCents: 7990 }] },
      { name: "Serviços Digitais", items: [{ description: "Skeelo Premium", amountCents: 1990 }] },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços", items: [{ description: "Plano Controle 20GB", amountCents: 7990 }] },
    ]);
    const contested: ContestedItem[] = [{ findingId: "fin_1", description: "Skeelo Premium", amountCents: 1990 }];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions).toEqual([
      { findingId: "fin_1", verdict: "disappeared", recoveredCents: 1990, evidence: "no pair on 2026-08 invoice" },
    ]);
    expect(outcome.recoveredCents).toBe(1990);
    expect(outcome.allSettled).toBe(true);
  });

  it("marks a contested item reversed when a credit matches its amount exactly, even though the item is still charged", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      { name: "Serviços Digitais", items: [{ description: "GoRead", amountCents: 1500 }] },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços Digitais", items: [{ description: "GoRead", amountCents: 1500 }] },
      { name: "Ajustes", items: [{ description: "Crédito referente a acordo", amountCents: -1500 }] },
    ]);
    const contested: ContestedItem[] = [{ findingId: "fin_1", description: "GoRead", amountCents: 1500 }];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions).toEqual([
      {
        findingId: "fin_1",
        verdict: "reversed",
        recoveredCents: 1500,
        evidence: "credit of -1500 matches contested 1500",
      },
    ]);
    expect(outcome.allSettled).toBe(true);
  });

  it("marks a contested item reversed via a double-amount credit even though the item also disappeared - reversal outranks disappearance", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      { name: "Serviços Digitais", items: [{ description: "Hube Jornais", amountCents: 995 }] },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Ajustes", items: [{ description: "Crédito referente a acordo", amountCents: -1990 }] },
    ]);
    const contested: ContestedItem[] = [{ findingId: "fin_1", description: "Hube Jornais", amountCents: 995 }];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions).toEqual([
      {
        findingId: "fin_1",
        verdict: "reversed",
        recoveredCents: 1990,
        evidence: "credit of -1990 matches double of contested 995",
      },
    ]);
    expect(outcome.allSettled).toBe(true);
  });

  it("marks a contested item still_charged when paired with a reduced amount and no matching credit", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      { name: "Serviços Digitais", items: [{ description: "NBA Básico", amountCents: 1990 }] },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços Digitais", items: [{ description: "NBA Básico", amountCents: 995 }] },
    ]);
    const contested: ContestedItem[] = [{ findingId: "fin_1", description: "NBA Básico", amountCents: 1990 }];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions).toEqual([
      {
        findingId: "fin_1",
        verdict: "still_charged",
        recoveredCents: 0,
        evidence: 'still charged as "NBA Básico" (995)',
      },
    ]);
    expect(outcome.allSettled).toBe(false);
  });

  it("sums recoveredCents across mixed verdicts as an integer, and allSettled is false when any item is still charged", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      {
        name: "Serviços Digitais",
        items: [
          { description: "Skeelo Premium", amountCents: 1990 },
          { description: "GoRead", amountCents: 1500 },
          { description: "NBA Básico", amountCents: 995 },
        ],
      },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      {
        name: "Serviços Digitais",
        items: [
          { description: "GoRead", amountCents: 1500 },
          { description: "NBA Básico", amountCents: 995 },
        ],
      },
      { name: "Ajustes", items: [{ description: "Crédito referente a acordo", amountCents: -1500 }] },
    ]);
    const contested: ContestedItem[] = [
      { findingId: "fin_skeelo", description: "Skeelo Premium", amountCents: 1990 },
      { findingId: "fin_goread", description: "GoRead", amountCents: 1500 },
      { findingId: "fin_nba", description: "NBA Básico", amountCents: 995 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions.map((r) => r.verdict)).toEqual(["disappeared", "reversed", "still_charged"]);
    expect(outcome.recoveredCents).toBe(1990 + 1500 + 0);
    expect(Number.isInteger(outcome.recoveredCents)).toBe(true);
    expect(outcome.allSettled).toBe(false);
  });

  it("throws with the description and both invoice descriptors when a contested item matches no line on the previous invoice", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      { name: "Serviços", items: [{ description: "Plano Controle 20GB", amountCents: 7990 }] },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços", items: [{ description: "Plano Controle 20GB", amountCents: 7990 }] },
    ]);
    const contested: ContestedItem[] = [{ findingId: "fin_ghost", description: "Serviço Fantasma", amountCents: 500 }];

    expect(() => classifyContestedItems({ previous, current, contested })).toThrowError(
      /Servi.o Fantasma.*Vivo.*2026-07-01.*Vivo.*2026-08-01/s,
    );
  });

  // A contested item whose description normalises to "" (a bare reference
  // code, per normalizeDescription's decision 1) must never match a
  // previous-invoice line - not even another line that also normalises to
  // "" - mirroring pairInvoiceItems' own rule that an empty normalised
  // description carries no evidence of sameness. This is the ambiguity the
  // task brief calls out explicitly: it must fall through to the generic
  // "no matching line" throw, not silently match by coincidence of both
  // being empty.
  it("throws for a contested item whose description normalises to empty, never matching a previous line that also normalises to empty", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      {
        name: "Serviços",
        items: [
          { description: "Plano Controle 20GB", amountCents: 7990 },
          { description: "000123-456", amountCents: 500 },
        ],
      },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços", items: [{ description: "Plano Controle 20GB", amountCents: 7990 }] },
    ]);
    const contested: ContestedItem[] = [{ findingId: "fin_code", description: "000987-654", amountCents: 500 }];

    expect(() => classifyContestedItems({ previous, current, contested })).toThrow(
      /000987-654.*has no matching line/,
    );
  });

  // Two identical previous lines: one pairs (exact pass, document order),
  // one disappears. Contested items are matched to previous lines in the
  // same document order, so the first contested finding must land on the
  // paired line and the second on the disappeared one.
  it("consumes duplicate previous lines one-to-one for duplicate contested descriptions, in document order", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      {
        name: "Serviços Digitais",
        items: [
          { description: "Skeelo Premium", amountCents: 1990 },
          { description: "Skeelo Premium", amountCents: 1990 },
        ],
      },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços Digitais", items: [{ description: "Skeelo Premium", amountCents: 1990 }] },
    ]);
    const contested: ContestedItem[] = [
      { findingId: "fin_first", description: "Skeelo Premium", amountCents: 1990 },
      { findingId: "fin_second", description: "Skeelo Premium", amountCents: 1990 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions.map((r) => [r.findingId, r.verdict])).toEqual([
      ["fin_first", "still_charged"],
      ["fin_second", "disappeared"],
    ]);
  });

  // "Hube Jornais" (995) would only match this credit as a double; "Clube de
  // Revistas" (1990) matches it exactly. Input order lists the
  // double-eligible item FIRST - a naive first-come assignment would hand it
  // the credit before the exact match is even considered. RF-201's
  // documented priority (exact before double) must still route the credit
  // to "Clube de Revistas".
  it("assigns a credit to the exact-amount match before a competing double-amount match, regardless of contested input order", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      {
        name: "Serviços Digitais",
        items: [
          { description: "Hube Jornais", amountCents: 995 },
          { description: "Clube de Revistas", amountCents: 1990 },
        ],
      },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Ajustes", items: [{ description: "Crédito referente a acordo", amountCents: -1990 }] },
    ]);
    const contested: ContestedItem[] = [
      { findingId: "fin_hube", description: "Hube Jornais", amountCents: 995 },
      { findingId: "fin_clube", description: "Clube de Revistas", amountCents: 1990 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions).toEqual([
      { findingId: "fin_hube", verdict: "disappeared", recoveredCents: 995, evidence: "no pair on 2026-08 invoice" },
      {
        findingId: "fin_clube",
        verdict: "reversed",
        recoveredCents: 1990,
        evidence: "credit of -1990 matches contested 1990",
      },
    ]);
  });

  // Two contested items tie on amount (both 1500) and only one credit of
  // -1500 exists. "Each credit line settles at most one contested item" -
  // the tie is broken by contested input order, so the first claims it and
  // the second falls through to its own pairing-based verdict.
  it("lets only one contested item claim a credit when two contested items tie on amount, honouring contested input order", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      {
        name: "Serviços Digitais",
        items: [
          { description: "GoRead", amountCents: 1500 },
          { description: "Clube de Revistas", amountCents: 1500 },
        ],
      },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Ajustes", items: [{ description: "Crédito referente a acordo", amountCents: -1500 }] },
    ]);
    const contested: ContestedItem[] = [
      { findingId: "fin_goread", description: "GoRead", amountCents: 1500 },
      { findingId: "fin_clube", description: "Clube de Revistas", amountCents: 1500 },
    ];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions.map((r) => [r.findingId, r.verdict])).toEqual([
      ["fin_goread", "reversed"],
      ["fin_clube", "disappeared"],
    ]);
  });

  // RF-201 ruling: a credit that also existed on the previous invoice is
  // not an estorno, because a line present on both N and N+1 is by
  // construction not a change between them - it is the same recurring
  // line (here, a loyalty discount) billed again, not evidence that money
  // came back. Without the `diff.paired` exclusion in `matchCredits`, this
  // recurring -1990 credit would be read as a reversal of the contested
  // 1990 charge even though the charge is still being billed.
  it("does not treat a credit as a reversal when the same credit line already existed on the previous invoice", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      { name: "Serviços Digitais", items: [{ description: "Skeelo Premium", amountCents: 1990 }] },
      { name: "Ajustes", items: [{ description: "Desconto Fidelidade", amountCents: -1990 }] },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços Digitais", items: [{ description: "Skeelo Premium", amountCents: 1990 }] },
      { name: "Ajustes", items: [{ description: "Desconto Fidelidade", amountCents: -1990 }] },
    ]);
    const contested: ContestedItem[] = [{ findingId: "fin_1", description: "Skeelo Premium", amountCents: 1990 }];

    const outcome = classifyContestedItems({ previous, current, contested });

    expect(outcome.resolutions).toEqual([
      {
        findingId: "fin_1",
        verdict: "still_charged",
        recoveredCents: 0,
        evidence: 'still charged as "Skeelo Premium" (1990)',
      },
    ]);
    expect(outcome.recoveredCents).toBe(0);
    expect(outcome.allSettled).toBe(false);
  });

  // Minor 2: the type comment on `ContestedItem.amountCents` says "positive
  // integer cents" but nothing enforced it - a caller passing reais (19.9)
  // instead of cents would flow straight into `recoveredCents` as a float.
  // This mirrors the fail-loud stance already taken for the other
  // caller-bug class (no matching previous line).
  it("throws when a contested item's amountCents is not a positive integer", () => {
    const previous = invoiceWith({ start: "2026-07-01", end: "2026-07-31" }, [
      { name: "Serviços", items: [{ description: "Plano Controle 20GB", amountCents: 7990 }] },
    ]);
    const current = invoiceWith({ start: "2026-08-01", end: "2026-08-31" }, [
      { name: "Serviços", items: [{ description: "Plano Controle 20GB", amountCents: 7990 }] },
    ]);
    const contested: ContestedItem[] = [
      { findingId: "fin_reais", description: "Plano Controle 20GB", amountCents: 19.9 },
    ];

    expect(() => classifyContestedItems({ previous, current, contested })).toThrow(/fin_reais.*19\.9/);
  });
});
