import { describe, expect, it } from "vitest";
import { pairInvoiceItems } from "./index.js";
import type { InvoiceCanonical } from "../invoice/canonical.js";

type ItemInput = { description: string; amountCents: number };
type SectionInput = { name: string; items: ItemInput[] };

/**
 * A minimal invoice with the given sections. Only the fields
 * `pairInvoiceItems` reads (`sections[].items[].description`) vary across
 * tests; the rest is fixed filler that satisfies `InvoiceCanonical`'s shape.
 */
function invoiceWith(sections: SectionInput[]): InvoiceCanonical {
  return {
    issuer: { name: "Claro Móvel", category: "telecom" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 10000,
    sections,
    extraction: { confidence: 0.9, warnings: [] },
  } as InvoiceCanonical;
}

/** A single-section invoice — the common case in these tests. */
function singleSection(items: ItemInput[], name = "Serviços"): InvoiceCanonical {
  return invoiceWith([{ name, items }]);
}

describe("pairInvoiceItems", () => {
  // RF-200 acceptance, exact-pass half: "Plano Móvel Controle" and
  // "PLANO MOVEL CONTROLE!!" differ in accents, case and punctuation, but
  // normalizeDescription (RF-122) folds all three away, so their
  // normalised descriptions are equal and the pair scores 1. (Score 1
  // alone does not prove *which* pass produced the pair — the exact pass
  // and the trigram pass both score an equal pair of non-empty normalised
  // descriptions at 1 — so this test observes only the score, not the
  // pass.)
  it("pairs items that differ only in accent, case and punctuation, with score 1", () => {
    const previous = singleSection([{ description: "Plano Móvel Controle", amountCents: 8990 }]);
    const current = singleSection([{ description: "PLANO MOVEL CONTROLE!!", amountCents: 8990 }]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toHaveLength(1);
    expect(diff.paired[0]?.score).toBe(1);
    expect(diff.paired[0]?.previous.description).toBe("Plano Móvel Controle");
    expect(diff.paired[0]?.current.description).toBe("PLANO MOVEL CONTROLE!!");
    expect(diff.disappeared).toEqual([]);
    expect(diff.appeared).toEqual([]);
  });

  // RULING: an item whose normalised description is empty pairs with
  // nothing — never with another empty one. "000123-456" and "000987-654"
  // are two unrelated code-only lines (a bare reference code, per
  // normalizeDescription's decision 1) that both normalise to "". An
  // empty normalised description is the *absence* of a description, not
  // a description two items share (see the doc comment above
  // pairInvoiceItems for the full rationale, including why this matches
  // trigramSimilarity("", "") being defined as 0, not 1). Before this
  // ruling, two such items paired on the exact pass at score 1 — the
  // maximum-confidence signal — so a genuinely disappeared charge would
  // never reach `disappeared` and a genuinely new one would never reach
  // `appeared`.
  it("does not pair two items whose normalised description is both empty", () => {
    const previous = singleSection([{ description: "000123-456", amountCents: 500 }]);
    const current = singleSection([{ description: "000987-654", amountCents: 500 }]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toEqual([]);
    expect(diff.disappeared).toHaveLength(1);
    expect(diff.disappeared[0]?.description).toBe("000123-456");
    expect(diff.appeared).toHaveLength(1);
    expect(diff.appeared[0]?.description).toBe("000987-654");
  });

  // RF-200 acceptance, trigram-pass half: "Serviço Mega" vs "Serviço
  // Megas" normalise to "SERVICO MEGA" vs "SERVICO MEGAS" — not equal, so
  // the exact pass cannot pair them. Their trigram similarity is exactly
  // 0.8 (SERVICO contributes 8 shared trigrams; MEGA/MEGAS contribute 4
  // shared out of a 7-trigram union: (8+4)/(8+7) = 12/15 = 0.8), so this
  // is also the boundary case for TRIGRAM_THRESHOLD's ">=".
  it("pairs a genuine spelling variant that only clears the trigram pass, with score below 1", () => {
    const previous = singleSection([{ description: "Serviço Mega", amountCents: 4990 }]);
    const current = singleSection([{ description: "Serviço Megas", amountCents: 4990 }]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toHaveLength(1);
    expect(diff.paired[0]?.score).toBe(0.8);
    expect(diff.disappeared).toEqual([]);
    expect(diff.appeared).toEqual([]);
  });

  // "Pacote Mega" vs "Pacote Megas" normalise to "PACOTE MEGA" vs "PACOTE
  // MEGAS": PACOTE contributes 7 shared trigrams, so similarity is
  // (7+4)/(7+7) = 11/14 ≈ 0.7857 — just under TRIGRAM_THRESHOLD. 0.8
  // Jaccard is strict for short descriptions like these; a real spelling
  // variant can fall just short of it. This test pins that the boundary
  // is not silently loosened.
  it("does not pair a near-miss just below the trigram threshold", () => {
    const previous = singleSection([{ description: "Pacote Mega", amountCents: 3000 }]);
    const current = singleSection([{ description: "Pacote Megas", amountCents: 3000 }]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toEqual([]);
    expect(diff.disappeared).toHaveLength(1);
    expect(diff.appeared).toHaveLength(1);
  });

  it("puts an item present only on the previous invoice in disappeared, and only there", () => {
    const previous = singleSection([
      { description: "Assinatura Revista Mensal", amountCents: 1990 },
      { description: "Plano Base", amountCents: 5000 },
    ]);
    const current = singleSection([{ description: "Plano Base", amountCents: 5000 }]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toHaveLength(1);
    expect(diff.disappeared).toHaveLength(1);
    expect(diff.disappeared[0]?.description).toBe("Assinatura Revista Mensal");
    expect(diff.appeared).toEqual([]);
  });

  it("puts an item new on the current invoice in appeared, and only there", () => {
    const previous = singleSection([{ description: "Plano Base", amountCents: 5000 }]);
    const current = singleSection([
      { description: "Plano Base", amountCents: 5000 },
      { description: "Taxa de Religação", amountCents: 1500 },
    ]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toHaveLength(1);
    expect(diff.disappeared).toEqual([]);
    expect(diff.appeared).toHaveLength(1);
    expect(diff.appeared[0]?.description).toBe("Taxa de Religação");
  });

  // Three identical lines on N, two on N+1: duplicates must pair
  // one-to-one in document order, not many-to-one. `amountCents` tags
  // each otherwise-identical item so the pairing (not just the count) can
  // be verified.
  it("pairs duplicate descriptions one-to-one in document order, leaving the correct leftover", () => {
    const previous = singleSection([
      { description: "Multa por atraso", amountCents: 100 },
      { description: "Multa por atraso", amountCents: 200 },
      { description: "Multa por atraso", amountCents: 300 },
    ]);
    const current = singleSection([
      { description: "Multa por atraso", amountCents: 400 },
      { description: "Multa por atraso", amountCents: 500 },
    ]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired.map((p) => [p.previous.amountCents, p.current.amountCents])).toEqual([
      [100, 400],
      [200, 500],
    ]);
    expect(diff.disappeared.map((i) => i.amountCents)).toEqual([300]);
    expect(diff.appeared).toEqual([]);
  });

  // Two previous items ("Serviço Mega" at index 0 and 1) both score
  // exactly 0.8 against the single current item ("Serviço Megas"). The
  // documented tie-break (previous-side index, then current-side index)
  // must consistently pick the lower previous index as the winner, and
  // running the pairing twice on the same input must not change that.
  it("breaks a tie between two previous items for the same current item by previous-side index, deterministically", () => {
    const previous = singleSection([
      { description: "Serviço Mega", amountCents: 100 },
      { description: "Serviço Mega", amountCents: 200 },
    ]);
    const current = singleSection([{ description: "Serviço Megas", amountCents: 400 }]);

    const first = pairInvoiceItems(previous, current);
    const second = pairInvoiceItems(previous, current);

    expect(first).toEqual(second);
    expect(first.paired).toHaveLength(1);
    expect(first.paired[0]?.previous.amountCents).toBe(100);
    expect(first.paired[0]?.current.amountCents).toBe(400);
    expect(first.disappeared.map((i) => i.amountCents)).toEqual([200]);
    expect(first.appeared).toEqual([]);
  });

  // Two previous items compete for the same current item with genuinely
  // *different* scores (not a tie). "Sega" is generated first in document
  // order but is the weaker spelling variant of "Mega"; "Megas" is
  // generated second but is the closer variant. Algorithm step 3 requires
  // taking candidates "greedily, highest score first" — so the stronger
  // match (Megas) must win even though it is not the first candidate
  // produced. This is what distinguishes the greedy score ordering from
  // the index tie-break covered by the previous test.
  it("prefers the higher-scoring trigram candidate over one generated earlier", () => {
    const previous = singleSection([
      { description: "Pacote Internet Fibra Sega", amountCents: 100 },
      { description: "Pacote Internet Fibra Megas", amountCents: 200 },
    ]);
    const current = singleSection([{ description: "Pacote Internet Fibra Mega", amountCents: 400 }]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toHaveLength(1);
    expect(diff.paired[0]?.previous.amountCents).toBe(200);
    expect(diff.paired[0]?.current.amountCents).toBe(400);
    expect(diff.disappeared.map((i) => i.amountCents)).toEqual([100]);
    expect(diff.appeared).toEqual([]);
  });

  // The other half of the documented tie-break: one previous item ties
  // for two current items with identical descriptions (both score exactly
  // 0.8 against it). The winner must be the lower current-side index.
  it("breaks a tie between two current items for the same previous item by current-side index", () => {
    const previous = singleSection([{ description: "Serviço Mega", amountCents: 100 }]);
    const current = singleSection([
      { description: "Serviço Megas", amountCents: 400 },
      { description: "Serviço Megas", amountCents: 500 },
    ]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toHaveLength(1);
    expect(diff.paired[0]?.previous.amountCents).toBe(100);
    expect(diff.paired[0]?.current.amountCents).toBe(400);
    expect(diff.disappeared).toEqual([]);
    expect(diff.appeared.map((i) => i.amountCents)).toEqual([500]);
  });

  // The flattening is invoice-wide, not per-section: an identical
  // description must still pair even when it moved from "Serviços" on the
  // previous invoice to "Serviços Digitais" on the current one. Each
  // invoice has a second, unrelated section too, and on the previous
  // invoice the shared item sits in that *second* section — so a
  // flattening that only looked at the first section of each invoice
  // would silently drop it and this test would catch that.
  it("pairs an item that moved to a different section", () => {
    const previous = invoiceWith([
      { name: "Outros", items: [{ description: "Anuidade Cartão Adicional", amountCents: 111 }] },
      { name: "Serviços", items: [{ description: "Suporte Técnico", amountCents: 2500 }] },
    ]);
    const current = invoiceWith([
      { name: "Serviços Digitais", items: [{ description: "Suporte Técnico", amountCents: 2500 }] },
      { name: "Outros", items: [{ description: "Assinatura Revista Mensal", amountCents: 222 }] },
    ]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired).toHaveLength(1);
    expect(diff.paired[0]?.score).toBe(1);
    expect(diff.paired[0]?.previous.description).toBe("Suporte Técnico");
    expect(diff.disappeared.map((i) => i.description)).toEqual(["Anuidade Cartão Adicional"]);
    expect(diff.appeared.map((i) => i.description)).toEqual(["Assinatura Revista Mensal"]);
  });

  // `paired` must be ordered by previous-side document order, even when
  // the pairs come from different passes. "Serviço Mega" sits at previous
  // index 0 but only clears the trigram pass (paired with "Serviço
  // Megas" at score 0.8); "Plano Base" sits at previous index 1 but
  // clears the exact pass first (paired with score 1). The exact pass
  // runs before the trigram pass and pushes its pairs first, so without
  // the final sort by previous-side index, `paired` would come out as
  // [Plano Base (index 1), Serviço Mega (index 0)] — reflecting pass
  // order, not document order. `amountCents` tags each pair so the order
  // is checked directly, not merely inferred from length.
  it("orders paired by previous-side document order, even when the trigram pair precedes the exact pair", () => {
    const previous = singleSection([
      { description: "Serviço Mega", amountCents: 100 },
      { description: "Plano Base", amountCents: 200 },
    ]);
    const current = singleSection([
      { description: "Plano Base", amountCents: 300 },
      { description: "Serviço Megas", amountCents: 400 },
    ]);

    const diff = pairInvoiceItems(previous, current);

    expect(diff.paired.map((p) => p.previous.amountCents)).toEqual([100, 200]);
    expect(diff.disappeared).toEqual([]);
    expect(diff.appeared).toEqual([]);
  });
});
