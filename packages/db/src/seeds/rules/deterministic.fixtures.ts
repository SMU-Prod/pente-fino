import type { InvoiceCanonical } from "@pentefino/core";
import {
  RN_001, RN_002, RN_003, RN_004, RN_005, RN_006, RN_007, RN_008, RN_009, RN_010, RN_011,
} from "./deterministic.js";

/**
 * Two fixture invoices per RN-001..011 — one that a correct evaluator should
 * fire on, one it should not — keyed by the rule's slug and matching the
 * `meta.role` / expression notation documented in `deterministic.ts`.
 *
 * `runRules` (RF-120) does not have real evaluators yet (that is Tasks 1/2 of
 * this block), so these fixtures cannot be run end to end today. What they
 * *can* do, and what `deterministic.test.ts` uses them for, is (a) prove
 * each one parses as a real `InvoiceCanonical` and (b) stand as the concrete
 * worked example — role names and all — that a future evaluator for this
 * rule has to make fire/not-fire correctly.
 */

type Scenario = { invoice: InvoiceCanonical; previous: InvoiceCanonical | null };
export type FixturePair = { fires: Scenario; clean: Scenario };

function inv(partial: Omit<InvoiceCanonical, "extraction">): InvoiceCanonical {
  return { ...partial, extraction: { confidence: 0.92, warnings: [] } };
}

// --- RN-001 — energy, multa base ------------------------------------------
//
// "Wrong base" invoice: the utility computes the 2% fine over
// consumo + COSIP + serviço acessório + multa anterior (34500 cents), giving
// a charged multa of 690 — above the true cap of 2% × 30000 = 600.
const rn001Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Enel SP", category: "energy" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 35190,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Consumo de energia elétrica", amountCents: 30000, meta: { role: "consumo" } },
        { description: "COSIP - Contribuição de Iluminação Pública", amountCents: 1500, meta: { role: "cosip" } },
        { description: "Serviços de terceiros - manutenção de padrão", amountCents: 2000, meta: { role: "servico_acessorio" } },
        { description: "Multa anterior em aberto", amountCents: 1000, meta: { role: "multa_anterior" } },
        { description: "Multa por atraso", amountCents: 690, meta: { role: "multa" } },
      ],
    }],
  }),
  previous: null,
};

// Clean invoice: multa is 2% of consumo alone (600), no COSIP/serviço
// acessório/multa anterior in the base at all.
const rn001Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Enel SP", category: "energy" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 30600,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Consumo de energia elétrica", amountCents: 30000, meta: { role: "consumo" } },
        { description: "Multa por atraso", amountCents: 600, meta: { role: "multa" } },
      ],
    }],
  }),
  previous: null,
};

// --- RN-002 — energy, acerto de faturamento >3 ciclos ----------------------

const rn002Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Enel SP", category: "energy" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 32000,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Consumo de energia elétrica", amountCents: 28000, meta: { role: "consumo" } },
        {
          description: "Acerto de faturamento",
          amountCents: 4000,
          meta: { role: "acerto_faturamento", ciclosCobertos: 4 },
        },
      ],
    }],
  }),
  previous: null,
};

const rn002Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Enel SP", category: "energy" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 31000,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Consumo de energia elétrica", amountCents: 28000, meta: { role: "consumo" } },
        {
          description: "Acerto de faturamento",
          amountCents: 3000,
          meta: { role: "acerto_faturamento", ciclosCobertos: 3 },
        },
      ],
    }],
  }),
  previous: null,
};

// --- RN-003 — energy, custo de disponibilidade -----------------------------
//
// Fires: monofásico (mínimo 30 kWh), consumo real 10 kWh, ciclo de 30 dias
// (>= 27, rule applies) but disponibilidade cobrada como soma (30+10=40)
// em vez do maior-entre (30).
const rn003Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Enel SP", category: "energy" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 15000,
    sections: [{
      name: "Fatura",
      items: [
        {
          description: "Custo de disponibilidade",
          amountCents: 15000,
          qty: 40,
          meta: { role: "disponibilidade", fase: "monofasico", minimoKwh: 30 },
        },
      ],
    }],
    readings: { previous: 1000, current: 1010, kwh: 10, estimated: false, days: 30 },
  }),
  previous: null,
};

// Clean: same numbers, but the cycle is only 20 days — RN-003's own
// exemption ("não cabe se o ciclo teve menos de 27 dias") applies, so this
// must not fire even though 40 > max(30, 10).
const rn003Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Enel SP", category: "energy" },
    period: { start: "2026-06-01", end: "2026-06-20" },
    dueDate: "2026-07-01",
    totalCents: 15000,
    sections: [{
      name: "Fatura",
      items: [
        {
          description: "Custo de disponibilidade",
          amountCents: 15000,
          qty: 40,
          meta: { role: "disponibilidade", fase: "monofasico", minimoKwh: 30 },
        },
      ],
    }],
    readings: { previous: 1000, current: 1010, kwh: 10, estimated: false, days: 20 },
  }),
  previous: null,
};

// --- RN-004 — water, leitura ------------------------------------------------
//
// Fires: current - previous (15 m3) does not match the billed consumption
// (18 m3 on the "Consumo Faturado" line).
const rn004Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Sabesp", category: "water" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 9000,
    sections: [{
      name: "Fatura",
      items: [
        {
          description: "Consumo de água faturado",
          amountCents: 9000,
          qty: 18,
          meta: { role: "consumo_faturado" },
        },
      ],
    }],
    readings: { previous: 100, current: 115, m3: 15, estimated: false, days: 30 },
  }),
  previous: null,
};

// Clean: current - previous (15 m3) matches the billed consumption exactly,
// and the measured reading agrees too — no meter change or adjustment
// needed for either of those clauses to stay silent.
const rn004Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Sabesp", category: "water" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 7500,
    sections: [{
      name: "Fatura",
      items: [
        {
          description: "Consumo de água faturado",
          amountCents: 7500,
          qty: 15,
          meta: { role: "consumo_faturado" },
        },
      ],
    }],
    readings: { previous: 100, current: 115, m3: 15, estimated: false, days: 30 },
  }),
  previous: null,
};

// --- RN-005 — water, média sem acerto ---------------------------------------
//
// Fires: previous cycle was estimated, this one is a real reading, and
// there is no "ajuste de consumo" line reconciling the two.
const rn005PreviousEstimated = inv({
  issuer: { name: "Sabesp", category: "water" },
  period: { start: "2026-05-01", end: "2026-05-31" },
  dueDate: "2026-06-10",
  totalCents: 6000,
  sections: [{
    name: "Fatura",
    items: [{ description: "Consumo de água estimado", amountCents: 6000, meta: { role: "consumo_faturado" } }],
  }],
  readings: { previous: 85, current: 100, m3: 15, estimated: true, days: 30 },
});

const rn005Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Sabesp", category: "water" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 7500,
    sections: [{
      name: "Fatura",
      items: [{ description: "Consumo de água medido", amountCents: 7500, meta: { role: "consumo_faturado" } }],
    }],
    readings: { previous: 100, current: 115, m3: 15, estimated: false, days: 30 },
  }),
  previous: rn005PreviousEstimated,
};

// Clean: same transition from an estimated cycle to a real one, but this
// invoice carries the "ajuste de consumo" line that reconciles them.
const rn005Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Sabesp", category: "water" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 7800,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Consumo de água medido", amountCents: 7500, meta: { role: "consumo_faturado" } },
        { description: "Ajuste de consumo (acerto de médias)", amountCents: 300, meta: { role: "ajuste_consumo" } },
      ],
    }],
    readings: { previous: 100, current: 115, m3: 15, estimated: false, days: 30 },
  }),
  previous: rn005PreviousEstimated,
};

// --- RN-006 — card, encargo com fatura paga --------------------------------
//
// Fires: this cycle carries a rotativo charge; the previous invoice carried
// none of juros/mora/rotativo (this seed's proxy for "paid in full and on
// time" — see the gap noted in deterministic.ts).
const rn006PreviousClean = inv({
  issuer: { name: "Itaú", category: "card" },
  period: { start: "2026-05-01", end: "2026-05-31" },
  dueDate: "2026-06-10",
  totalCents: 50000,
  sections: [{
    name: "Fatura",
    items: [{ description: "Compras do período", amountCents: 50000, meta: { role: "principal" } }],
  }],
});

const rn006Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 51500,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Compras do período", amountCents: 50000, meta: { role: "principal" } },
        { description: "Juros rotativo", amountCents: 1500, meta: { role: "rotativo" } },
      ],
    }],
  }),
  previous: rn006PreviousClean,
};

// Clean: the previous invoice already carried a rotativo charge itself, so
// the "cycle N-1 was paid in full and on time" precondition is not met, and
// this cycle's own rotativo charge is not (by this proxy) improper.
const rn006PreviousAlreadyRotativo = inv({
  issuer: { name: "Itaú", category: "card" },
  period: { start: "2026-05-01", end: "2026-05-31" },
  dueDate: "2026-06-10",
  totalCents: 51200,
  sections: [{
    name: "Fatura",
    items: [
      { description: "Compras do período", amountCents: 50000, meta: { role: "principal" } },
      { description: "Juros rotativo", amountCents: 1200, meta: { role: "rotativo" } },
    ],
  }],
});

const rn006Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 51500,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Compras do período", amountCents: 50000, meta: { role: "principal" } },
        { description: "Juros rotativo", amountCents: 1500, meta: { role: "rotativo" } },
      ],
    }],
  }),
  previous: rn006PreviousAlreadyRotativo,
};

// --- RN-007 — card, teto de 100% ------------------------------------------
//
// Fires: debt originated in 2026 (after the 2024-01-01 cutoff); encargos
// (juros+mora+rotativo+parcelamento, excluding IOF) of 120000 exceed the
// principal of 100000.
const rn007Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 220500,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Saldo devedor", amountCents: 100000, meta: { role: "principal" } },
        { description: "Juros do rotativo", amountCents: 70000, meta: { role: "rotativo" } },
        { description: "Multa e mora", amountCents: 30000, meta: { role: "mora" } },
        { description: "Parcelamento do saldo", amountCents: 20000, meta: { role: "parcelamento" } },
        { description: "IOF", amountCents: 500, meta: { role: "iof" } },
      ],
    }],
  }),
  previous: null,
};

// Clean: identical charges, but the debt's cycle predates the 2024-01-01
// cutoff, so the 100% ceiling of Lei 14.690/2023 does not yet apply to it.
const rn007Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2023-06-01", end: "2023-06-30" },
    dueDate: "2023-07-10",
    totalCents: 220500,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Saldo devedor", amountCents: 100000, meta: { role: "principal" } },
        { description: "Juros do rotativo", amountCents: 70000, meta: { role: "rotativo" } },
        { description: "Multa e mora", amountCents: 30000, meta: { role: "mora" } },
        { description: "Parcelamento do saldo", amountCents: 20000, meta: { role: "parcelamento" } },
        { description: "IOF", amountCents: 500, meta: { role: "iof" } },
      ],
    }],
  }),
  previous: null,
};

// --- RN-008 — card, renovação cadastral ------------------------------------

const rn008Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 51590,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Compras do período", amountCents: 50000, meta: { role: "principal" } },
        { description: "Tarifa de Renovação de Cadastro", amountCents: 1590 },
      ],
    }],
  }),
  previous: null,
};

const rn008Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 50000,
    sections: [{
      name: "Fatura",
      items: [{ description: "Compras do período", amountCents: 50000, meta: { role: "principal" } }],
    }],
  }),
  previous: null,
};

// --- RN-009 — card, avaliação emergencial de crédito -----------------------

const rn009Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 60000,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Compras do período", amountCents: 50000, meta: { role: "principal" } },
        { description: "Avaliação Emergencial de Crédito", amountCents: 5000, periodRef: "2026-06-05" },
        { description: "Avaliação Emergencial de Crédito", amountCents: 5000, periodRef: "2026-06-22" },
      ],
    }],
  }),
  previous: null,
};

const rn009Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 55000,
    sections: [{
      name: "Fatura",
      items: [
        { description: "Compras do período", amountCents: 50000, meta: { role: "principal" } },
        { description: "Avaliação Emergencial de Crédito", amountCents: 5000, periodRef: "2026-06-05" },
      ],
    }],
  }),
  previous: null,
};

// --- RN-010 — card/bank, serviços essenciais gratuitos ----------------------

const rn010Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 0,
    sections: [{
      name: "Resumo de serviços essenciais",
      items: [{
        description: "Resumo de uso — serviços essenciais",
        amountCents: 0,
        meta: { role: "resumo_servicos_essenciais", tipoConta: "corrente", saques: 6, extratos: 1 },
      }],
    }],
  }),
  previous: null,
};

const rn010Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 0,
    sections: [{
      name: "Resumo de serviços essenciais",
      items: [{
        description: "Resumo de uso — serviços essenciais",
        amountCents: 0,
        meta: { role: "resumo_servicos_essenciais", tipoConta: "corrente", saques: 4, extratos: 2 },
      }],
    }],
  }),
  previous: null,
};

// --- RN-011 — card/bank, pacote de serviços --------------------------------

const rn011Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 3990,
    sections: [{
      name: "Tarifas",
      items: [{
        description: "Pacote Essencial",
        amountCents: 3990,
        meta: { role: "pacote", somaTarifasIndividuaisCents: 3500 },
      }],
    }],
  }),
  previous: null,
};

const rn011Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Itaú", category: "card" },
    period: { start: "2026-06-01", end: "2026-06-30" },
    dueDate: "2026-07-10",
    totalCents: 2990,
    sections: [{
      name: "Tarifas",
      items: [{
        description: "Pacote Essencial",
        amountCents: 2990,
        meta: { role: "pacote", somaTarifasIndividuaisCents: 3500 },
      }],
    }],
  }),
  previous: null,
};

export const DETERMINISTIC_FIXTURES: Record<string, FixturePair> = {
  [RN_001]: { fires: rn001Fires, clean: rn001Clean },
  [RN_002]: { fires: rn002Fires, clean: rn002Clean },
  [RN_003]: { fires: rn003Fires, clean: rn003Clean },
  [RN_004]: { fires: rn004Fires, clean: rn004Clean },
  [RN_005]: { fires: rn005Fires, clean: rn005Clean },
  [RN_006]: { fires: rn006Fires, clean: rn006Clean },
  [RN_007]: { fires: rn007Fires, clean: rn007Clean },
  [RN_008]: { fires: rn008Fires, clean: rn008Clean },
  [RN_009]: { fires: rn009Fires, clean: rn009Clean },
  [RN_010]: { fires: rn010Fires, clean: rn010Clean },
  [RN_011]: { fires: rn011Fires, clean: rn011Clean },
};
