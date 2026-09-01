import { describe, expect, it } from "vitest";
import { reference } from "./index.js";
import type { ActiveRule } from "../engine.js";
import type { InvoiceCanonical } from "../../invoice/canonical.js";
import type { EvaluationContext, References } from "./types.js";
import type { ReferenceTariff, ReferenceFlag } from "../references.js";

const CNPJ = "11222333000181";
const OTHER_CNPJ = "99999999000199";

function energyInvoice(overrides: Partial<InvoiceCanonical> = {}): InvoiceCanonical {
  return {
    issuer: { name: "Light Energia", cnpj: CNPJ, category: "energy" },
    period: { start: "2026-08-01", end: "2026-08-31" },
    dueDate: "2026-09-10",
    totalCents: 50000,
    sections: [{ name: "Fornecimento", items: [{ description: "Consumo", amountCents: 50000 }] }],
    extraction: { confidence: 0.9, warnings: [] },
    ...overrides,
  } as InvoiceCanonical;
}

function tariffRow(overrides: Partial<ReferenceTariff> = {}): ReferenceTariff {
  return {
    issuerCnpj: CNPJ,
    subgroup: "B1",
    modality: "Convencional",
    className: "Residencial",
    subClass: "Normal",
    validFrom: "2026-08-01",
    validTo: null,
    tusdCentsMwh: 45000,
    teCentsMwh: 27000,
    dscBaseTarifa: "Tarifa de Aplicação",
    ...overrides,
  };
}

function referenceRule(overrides: {
  source: "aneel_tariff" | "aneel_flag" | "cdc_limits";
  tolerancePct: number;
}): ActiveRule {
  return {
    slug: "rn-040",
    version: 1,
    spec: { kind: "reference", source: overrides.source, tolerancePct: overrides.tolerancePct },
    confidenceBase: 0.75,
    shadow: false,
    legalBasis: [{ law: "REN 1.000/2021", article: "art. 348", effect: "limite" }],
    issuerId: null,
  };
}

function ctx(invoice: InvoiceCanonical, references: References): EvaluationContext {
  return { invoice, previous: null, references, answers: {} };
}

describe("reference - guards", () => {
  it("returns nothing when called with a rule of a different kind (defensive dispatch guard)", () => {
    const notReference: ActiveRule = {
      slug: "not-reference",
      version: 1,
      spec: { kind: "threshold", expr: "total", operator: ">", value: 0 },
      confidenceBase: 0.5,
      shadow: false,
      legalBasis: [{ law: "CDC", article: "39", effect: "vedada" }],
      issuerId: null,
    };
    expect(reference(notReference, ctx(energyInvoice(), { tariffs: [], flags: [] }))).toEqual([]);
  });
});

describe("reference - aneel_tariff", () => {
  it("produces nothing when no reference data is supplied", () => {
    const invoice = energyInvoice({
      tariffs: { teCentsKwh: 60, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const findings = reference(referenceRule({ source: "aneel_tariff", tolerancePct: 2 }), ctx(invoice, { tariffs: [], flags: [] }));
    expect(findings).toEqual([]);
  });

  it(
    "DscBaseTarifa regression (§12.3 RN-040): a tariff row under any base other than " +
      "'Tarifa de Aplicação' must never be used, even when it is the only row available " +
      "for the CNPJ and period",
    () => {
      const invoice = energyInvoice({
        tariffs: { teCentsKwh: 60, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
        readings: { previous: 0, current: 400, kwh: 400, estimated: false },
      });
      const wrongBase = tariffRow({
        dscBaseTarifa: "Tarifa de Uso do Sistema",
        tusdCentsMwh: 999_999,
        teCentsMwh: 999_999,
      });
      const findings = reference(
        referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
        ctx(invoice, { tariffs: [wrongBase], flags: [] }),
      );
      expect(findings).toEqual([]);
    },
  );

  it("joins by CNPJ, never by issuer name or acronym: a tariff row for a different CNPJ is not matched", () => {
    const invoice = energyInvoice({
      tariffs: { teCentsKwh: 60, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const otherCnpjRow = tariffRow({ issuerCnpj: OTHER_CNPJ });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [otherCnpjRow], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it("produces nothing when the invoice carries no CNPJ to join on", () => {
    const invoice = energyInvoice({
      issuer: { name: "Light Energia", category: "energy" },
      tariffs: { teCentsKwh: 60, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [tariffRow()], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it("produces nothing when the invoice is missing PIS/COFINS/ICMS - never falls back to a fixed rate", () => {
    const invoice = energyInvoice({
      tariffs: { teCentsKwh: 60, tusdCentsKwh: 45 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [tariffRow()], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it(
    "worked example (hand-computed): TUSD 450 + TE 270 R$/MWh grossed up by PIS 1.65% + " +
      "COFINS 7.6% + ICMS 18% is exactly 480 000 000/4961 cents/MWh (~96.7547 cents/kWh); " +
      "an invoice billing 105 cents/kWh over 400 kWh deviates 8.52%, exceeding a 2% tolerance, " +
      "by exactly 3298 cents (40905/4961 cents/kWh x 400 kWh, rounded once at the end)",
    () => {
      const invoice = energyInvoice({
        tariffs: { teCentsKwh: 60, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
        readings: { previous: 0, current: 400, kwh: 400, estimated: false },
      });
      const findings = reference(
        referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
        ctx(invoice, { tariffs: [tariffRow()], flags: [] }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.amountCents).toBe(3298);
      expect(findings[0]?.legalBasis).toEqual(referenceRule({ source: "aneel_tariff", tolerancePct: 2 }).legalBasis);
      expect(findings[0]?.evidence.length).toBeGreaterThan(0);
    },
  );

  it("produces nothing when the invoice is missing its declared TE/TUSD unit price", () => {
    const invoice = energyInvoice({
      tariffs: { pis: 0.0165, cofins: 0.076, icms: 0.18 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [tariffRow()], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it("produces nothing when the invoice has no kWh reading to price the disputed amount against", () => {
    const invoice = energyInvoice({
      tariffs: { teCentsKwh: 60, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
    });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [tariffRow()], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it("also fires when the invoice's unit price sits below the grossed-up reference - RN-040 checks for any divergence, not just an overcharge", () => {
    const invoice = energyInvoice({
      // reference (no taxes) is exactly 50 cents/kWh; billed at 40, 20% under
      tariffs: { teCentsKwh: 15, tusdCentsKwh: 25, pis: 0, cofins: 0, icms: 0 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const flatRow = tariffRow({ tusdCentsMwh: 30000, teCentsMwh: 20000 });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [flatRow], flags: [] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(4000); // 10 cents/kWh x 400 kWh
  });

  it("does not fire when the invoice's unit price is within tolerance of the grossed-up reference", () => {
    const invoice = energyInvoice({
      tariffs: { teCentsKwh: 52, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [tariffRow()], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it("treats the tolerance boundary itself as within tolerance (exceeds is a strict >)", () => {
    const invoice = energyInvoice({
      // no taxes: tarifa_com == tarifa_sem == 50 cents/kWh exactly; billed at 51 = exactly +2%
      tariffs: { teCentsKwh: 20, tusdCentsKwh: 31, pis: 0, cofins: 0, icms: 0 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const flatRow = tariffRow({ tusdCentsMwh: 30000, teCentsMwh: 20000 });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [flatRow], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it(
    "pro-rates across a mid-cycle tariff revision by day count (hand-computed): 15 days at " +
      "600 cents/MWh and 16 days at 660 cents/MWh over a 31-day cycle weight to exactly " +
      "1 956 000/31 cents/MWh; billed at 70 cents/kWh over 300 kWh exceeds a 2% tolerance " +
      "by exactly 2071 cents",
    () => {
      const invoice = energyInvoice({
        tariffs: { teCentsKwh: 20, tusdCentsKwh: 50, pis: 0, cofins: 0, icms: 0 },
        readings: { previous: 0, current: 300, kwh: 300, estimated: false },
      });
      const beforeRevision = tariffRow({
        validFrom: "2026-07-01",
        validTo: "2026-08-15",
        tusdCentsMwh: 40000,
        teCentsMwh: 20000,
      });
      const afterRevision = tariffRow({
        validFrom: "2026-08-16",
        validTo: null,
        tusdCentsMwh: 44000,
        teCentsMwh: 22000,
      });
      const findings = reference(
        referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
        ctx(invoice, { tariffs: [beforeRevision, afterRevision], flags: [] }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.amountCents).toBe(2071);
    },
  );

  it("produces nothing when two tariff rows overlap the same period ambiguously rather than partitioning it", () => {
    const invoice = energyInvoice({
      tariffs: { teCentsKwh: 60, tusdCentsKwh: 45, pis: 0.0165, cofins: 0.076, icms: 0.18 },
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
    });
    const residential = tariffRow({ subClass: "Residencial" });
    const commercial = tariffRow({ subClass: "Comercial", tusdCentsMwh: 50000, teCentsMwh: 30000 });
    const findings = reference(
      referenceRule({ source: "aneel_tariff", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [residential, commercial], flags: [] }),
    );
    expect(findings).toEqual([]);
  });
});

describe("reference - aneel_flag", () => {
  function flagRow(overrides: Partial<ReferenceFlag> = {}): ReferenceFlag {
    return { competence: "2026-08-01", flag: "vermelha_1", valueCentsPer100Kwh: 500, ...overrides };
  }

  it("produces nothing when no reference data is supplied", () => {
    const invoice = energyInvoice();
    const findings = reference(
      referenceRule({ source: "aneel_flag", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [], flags: [] }),
    );
    expect(findings).toEqual([]);
  });

  it("flags a surcharge charged in a green-flag month (positive)", () => {
    const invoice = energyInvoice({
      sections: [
        {
          name: "Fornecimento",
          items: [
            { description: "Consumo", amountCents: 50000 },
            { description: "Adicional Bandeira Vermelha", amountCents: 1500 },
          ],
        },
      ],
    });
    const findings = reference(
      referenceRule({ source: "aneel_flag", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [], flags: [flagRow({ flag: "verde", valueCentsPer100Kwh: 0 })] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.amountCents).toBe(1500);
    expect(findings[0]?.evidence[0]).toMatch(/bandeira/i);
  });

  it("does not fire when the surcharge matches the flag value in force for the competence (negative)", () => {
    const invoice = energyInvoice({
      readings: { previous: 0, current: 400, kwh: 400, estimated: false },
      sections: [
        {
          name: "Fornecimento",
          items: [
            { description: "Consumo", amountCents: 50000 },
            { description: "Adicional Bandeira Vermelha", amountCents: 2000 },
          ],
        },
      ],
    });
    const findings = reference(
      referenceRule({ source: "aneel_flag", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [], flags: [flagRow({ flag: "vermelha_1", valueCentsPer100Kwh: 500 })] }),
    );
    expect(findings).toEqual([]);
  });

  it("produces nothing when there is no reference row for this competence, even with other competences present", () => {
    const invoice = energyInvoice();
    const findings = reference(
      referenceRule({ source: "aneel_flag", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [], flags: [flagRow({ competence: "2026-07-01" })] }),
    );
    expect(findings).toEqual([]);
  });

  it("produces nothing when more than one line item looks like the flag surcharge - ambiguous", () => {
    const invoice = energyInvoice({
      sections: [
        {
          name: "Fornecimento",
          items: [
            { description: "Adicional Bandeira Vermelha", amountCents: 1500 },
            { description: "Bandeira Amarela (ciclo anterior)", amountCents: 300 },
          ],
        },
      ],
    });
    const findings = reference(
      referenceRule({ source: "aneel_flag", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [], flags: [flagRow({ flag: "verde", valueCentsPer100Kwh: 0 })] }),
    );
    expect(findings).toEqual([]);
  });

  it("produces nothing for a non-green flag when the invoice has no kWh reading to price the expected surcharge", () => {
    const invoice = energyInvoice({
      sections: [
        {
          name: "Fornecimento",
          items: [{ description: "Adicional Bandeira Vermelha", amountCents: 1500 }],
        },
      ],
    });
    const findings = reference(
      referenceRule({ source: "aneel_flag", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [], flags: [flagRow({ flag: "vermelha_1", valueCentsPer100Kwh: 500 })] }),
    );
    expect(findings).toEqual([]);
  });
});

describe("reference - cdc_limits", () => {
  it("produces nothing: no reference table backs cdc_limits yet (documented limitation)", () => {
    const invoice = energyInvoice();
    const findings = reference(
      referenceRule({ source: "cdc_limits", tolerancePct: 2 }),
      ctx(invoice, { tariffs: [], flags: [] }),
    );
    expect(findings).toEqual([]);
  });
});
