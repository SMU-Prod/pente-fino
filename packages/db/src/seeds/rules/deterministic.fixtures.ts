import type { InvoiceCanonical } from "@pentefino/core";
import {
  SECTION,
  RN_001, RN_002, RN_003, RN_004_CONSISTENCIA, RN_004_RETROCESSO, RN_005, RN_006,
  RN_007, RN_008, RN_009, RN_010_SAQUES, RN_010_EXTRATOS, RN_011,
} from "./deterministic.js";

/**
 * Two fixture invoices per seeded rule — one the rule's evaluator must fire
 * on, one it must not — keyed by slug. `deterministic.test.ts` runs the real
 * evaluators over both, so these are executable claims about each rule, not
 * illustrations.
 *
 * ## Sections carry the meaning
 *
 * The expression language behind `threshold` and `arithmetic` aggregates
 * over `InvoiceCanonical` **section names** and cannot look inside an item
 * (see `deterministic.ts`'s header). So the invoices below put each concept
 * a rule weighs — the fine, COSIP, the principal, the charges, the
 * withdrawals — in its own section, named from {@link SECTION}. Anything
 * shaping a real invoice for this engine has to do the same, or these rules
 * are silently inert on it.
 *
 * Sections no rule aggregates over (a water consumption line, say) are
 * written as plain strings: nothing reads them, so nothing can break by
 * misspelling one.
 *
 * ## `firesAmountCents` pins the value, not just the fact
 *
 * A rule that fires on the right invoice for the wrong reason still passes a
 * bare "produced a finding" assertion. Each pair therefore records the
 * amount the finding must carry, which for the ceiling rules is the exact
 * overcharge — RN-001's acceptance criterion in §12.1 is literally "achado
 * com valor exato da diferença".
 *
 * Three of these amounts are **counts, not money**: RN-002, RN-009 and both
 * halves of RN-010 compare a `sectionCount`, and the `threshold` evaluator
 * derives `amountCents` from whatever `expr` computed. The expected values
 * below say so plainly rather than hiding it, because that rough edge is
 * real and documented in both `threshold.ts` and `deterministic.ts`.
 *
 * ## `answer` drives the two `confirm` rules
 *
 * RN-005 and RN-006 are questions (see `deterministic.ts` on why). Their
 * fixtures carry the user's answer instead of a differently-shaped invoice:
 * "Não" is a dispute and must produce a finding, "Sim" must not. The test
 * builds the `ctx.answers` key with `confirmAnswerKey`, so the key format
 * stays defined in exactly one place — the evaluator that reads it.
 */

type Scenario = {
  invoice: InvoiceCanonical;
  previous: InvoiceCanonical | null;
  /** Only meaningful for a `confirm` rule; see the header. */
  answer?: string;
};

export type FixturePair = {
  fires: Scenario;
  clean: Scenario;
  /** The `amountCents` the firing finding must carry. */
  firesAmountCents: number;
};

function inv(partial: Omit<InvoiceCanonical, "extraction">): InvoiceCanonical {
  return { ...partial, extraction: { confidence: 0.92, warnings: [] } };
}

const ENERGY = { name: "Enel SP", category: "energy" } as const;
const WATER = { name: "Sabesp", category: "water" } as const;
const CARD = { name: "Itaú", category: "card" } as const;

const JUNE = { start: "2026-06-01", end: "2026-06-30" } as const;
const MAY = { start: "2026-05-01", end: "2026-05-31" } as const;

// --- RN-001 — energy, the fine's base --------------------------------------
//
// Fires: the utility took 2% of consumo + COSIP + serviço acessório + multa
// anterior (34500) and charged 690, where the lawful base is the 30000 of
// consumption alone and the cap is 600. The finding must be the 90 cents of
// difference — §12.1's acceptance criterion for this rule.
const rn001Fires: Scenario = {
  invoice: inv({
    issuer: ENERGY,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 35190,
    sections: [
      { name: SECTION.consumoEnergia, items: [{ description: "Consumo de energia elétrica", amountCents: 30000 }] },
      { name: SECTION.cosip, items: [{ description: "COSIP - Contribuição de Iluminação Pública", amountCents: 1500 }] },
      { name: SECTION.servicosAcessorios, items: [{ description: "Serviços de terceiros - manutenção de padrão", amountCents: 2000 }] },
      { name: SECTION.multasAnteriores, items: [{ description: "Multa anterior em aberto", amountCents: 1000 }] },
      { name: SECTION.multa, items: [{ description: "Multa por atraso", amountCents: 690 }] },
    ],
  }),
  previous: null,
};

// Clean: the same invoice in every respect except that the fine is 2% of the
// lawful base (600). Every section the rule reads is present, so this
// exercises the arithmetic itself rather than passing on missing data.
const rn001Clean: Scenario = {
  invoice: inv({
    issuer: ENERGY,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 35100,
    sections: [
      { name: SECTION.consumoEnergia, items: [{ description: "Consumo de energia elétrica", amountCents: 30000 }] },
      { name: SECTION.cosip, items: [{ description: "COSIP - Contribuição de Iluminação Pública", amountCents: 1500 }] },
      { name: SECTION.servicosAcessorios, items: [{ description: "Serviços de terceiros - manutenção de padrão", amountCents: 2000 }] },
      { name: SECTION.multasAnteriores, items: [{ description: "Multa anterior em aberto", amountCents: 1000 }] },
      { name: SECTION.multa, items: [{ description: "Multa por atraso", amountCents: 600 }] },
    ],
  }),
  previous: null,
};

// --- RN-002 — energy, an adjustment spanning more than 3 cycles ------------
//
// One item per cycle covered: four here, three in the clean invoice, which
// is the limit art. 324 allows.
const rn002Fires: Scenario = {
  invoice: inv({
    issuer: ENERGY,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 32000,
    sections: [
      { name: SECTION.consumoEnergia, items: [{ description: "Consumo de energia elétrica", amountCents: 28000 }] },
      {
        name: SECTION.acertoFaturamento,
        items: [
          { description: "Acerto de faturamento", amountCents: 1000, periodRef: "2026-02" },
          { description: "Acerto de faturamento", amountCents: 1000, periodRef: "2026-03" },
          { description: "Acerto de faturamento", amountCents: 1000, periodRef: "2026-04" },
          { description: "Acerto de faturamento", amountCents: 1000, periodRef: "2026-05" },
        ],
      },
    ],
  }),
  previous: null,
};

const rn002Clean: Scenario = {
  invoice: inv({
    issuer: ENERGY,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 31000,
    sections: [
      { name: SECTION.consumoEnergia, items: [{ description: "Consumo de energia elétrica", amountCents: 28000 }] },
      {
        name: SECTION.acertoFaturamento,
        items: [
          { description: "Acerto de faturamento", amountCents: 1000, periodRef: "2026-03" },
          { description: "Acerto de faturamento", amountCents: 1000, periodRef: "2026-04" },
          { description: "Acerto de faturamento", amountCents: 1000, periodRef: "2026-05" },
        ],
      },
    ],
  }),
  previous: null,
};

// --- RN-003 — energy, availability cost billed as a sum --------------------
//
// Fires: 10 kWh consumed against a 30 kWh minimum, and the invoice charges
// *both* — the consumption line and the availability line — which is the
// "nunca a soma" §12.1 forbids. The smaller of the two (1200) is the amount
// that should not be there.
const rn003Fires: Scenario = {
  invoice: inv({
    issuer: ENERGY,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 4800,
    sections: [
      { name: SECTION.consumoEnergia, items: [{ description: "Consumo de energia elétrica - 10 kWh", amountCents: 1200 }] },
      { name: SECTION.custoDisponibilidade, items: [{ description: "Custo de disponibilidade - 30 kWh", amountCents: 3600 }] },
    ],
    readings: { previous: 1000, current: 1010, kwh: 10, estimated: false, days: 30 },
  }),
  previous: null,
};

// Clean: consumption well above any phase minimum, so there is no
// availability line at all — which is what a correct invoice looks like in
// that case, not an artefact of the fixture.
const rn003Clean: Scenario = {
  invoice: inv({
    issuer: ENERGY,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 30000,
    sections: [
      { name: SECTION.consumoEnergia, items: [{ description: "Consumo de energia elétrica - 250 kWh", amountCents: 30000 }] },
    ],
    readings: { previous: 1000, current: 1250, kwh: 250, estimated: false, days: 30 },
  }),
  previous: null,
};

// --- RN-004, first hypothesis — water, the readings do not close -----------
//
// Fires: the meter moved 15 m³ (100 → 115) and the invoice bills 18.
const rn004ConsistenciaFires: Scenario = {
  invoice: inv({
    issuer: WATER,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 9000,
    sections: [{ name: "Consumo de Água", items: [{ description: "Consumo de água faturado - 18 m3", amountCents: 9000 }] }],
    readings: { previous: 100, current: 115, m3: 18, estimated: false, days: 30 },
  }),
  previous: null,
};

const rn004ConsistenciaClean: Scenario = {
  invoice: inv({
    issuer: WATER,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 7500,
    sections: [{ name: "Consumo de Água", items: [{ description: "Consumo de água faturado - 15 m3", amountCents: 7500 }] }],
    readings: { previous: 100, current: 115, m3: 15, estimated: false, days: 30 },
  }),
  previous: null,
};

// --- RN-004, second hypothesis — water, the meter ran backwards ------------
//
// Fires: 100 → 95. A real meter swap would look identical, which is exactly
// the false positive `deterministic.ts` records for this rule.
const rn004RetrocessoFires: Scenario = {
  invoice: inv({
    issuer: WATER,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 6000,
    sections: [{ name: "Consumo de Água", items: [{ description: "Consumo de água faturado", amountCents: 6000 }] }],
    readings: { previous: 100, current: 95, m3: 12, estimated: false, days: 30 },
  }),
  previous: null,
};

const rn004RetrocessoClean: Scenario = {
  invoice: inv({
    issuer: WATER,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 7500,
    sections: [{ name: "Consumo de Água", items: [{ description: "Consumo de água faturado", amountCents: 7500 }] }],
    readings: { previous: 100, current: 115, m3: 15, estimated: false, days: 30 },
  }),
  previous: null,
};

// --- RN-005 — water, an estimated cycle with no reconciliation -------------
//
// The invoices tell the story the question is about (an estimated May, a
// measured June), but the evaluator decides on the answer alone: "Não" means
// the acerto never appeared.
const rn005PreviousEstimated = inv({
  issuer: WATER,
  period: MAY,
  dueDate: "2026-06-10",
  totalCents: 6000,
  sections: [{ name: "Consumo de Água", items: [{ description: "Consumo de água estimado", amountCents: 6000 }] }],
  readings: { previous: 85, current: 100, m3: 15, estimated: true, days: 30 },
});

const rn005CurrentMeasured = inv({
  issuer: WATER,
  period: JUNE,
  dueDate: "2026-07-10",
  totalCents: 7500,
  sections: [{ name: "Consumo de Água", items: [{ description: "Consumo de água medido", amountCents: 7500 }] }],
  readings: { previous: 100, current: 115, m3: 15, estimated: false, days: 30 },
});

const rn005Fires: Scenario = {
  invoice: rn005CurrentMeasured,
  previous: rn005PreviousEstimated,
  answer: "Não",
};

const rn005Clean: Scenario = {
  invoice: rn005CurrentMeasured,
  previous: rn005PreviousEstimated,
  answer: "Sim",
};

// --- RN-006 — card, interest on a cycle that was paid in full --------------
//
// Same shape as RN-005: the charge is on the invoice either way, and only
// the user knows whether the previous cycle was settled on time.
const rn006Previous = inv({
  issuer: CARD,
  period: MAY,
  dueDate: "2026-06-10",
  totalCents: 50000,
  sections: [{ name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] }],
});

const rn006Current = inv({
  issuer: CARD,
  period: JUNE,
  dueDate: "2026-07-10",
  totalCents: 51500,
  sections: [
    { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
    { name: SECTION.encargos, items: [{ description: "Juros rotativo", amountCents: 1500 }] },
  ],
});

const rn006Fires: Scenario = { invoice: rn006Current, previous: rn006Previous, answer: "Não" };
const rn006Clean: Scenario = { invoice: rn006Current, previous: rn006Previous, answer: "Sim" };

// --- RN-007 — card, charges above the principal ----------------------------
//
// Fires: 120000 of encargos against a principal of 100000. IOF sits in its
// own section because §12.1 excludes it from the sum, and the finding is the
// 20000 above the ceiling.
const rn007Fires: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 220500,
    sections: [
      { name: SECTION.principal, items: [{ description: "Saldo devedor", amountCents: 100000 }] },
      {
        name: SECTION.encargos,
        items: [
          { description: "Juros do rotativo", amountCents: 70000 },
          { description: "Multa e mora", amountCents: 30000 },
          { description: "Parcelamento do saldo", amountCents: 20000 },
        ],
      },
      { name: SECTION.iof, items: [{ description: "IOF", amountCents: 500 }] },
    ],
  }),
  previous: null,
};

// Clean: the same charge types, below the ceiling. Not "the same invoice
// dated 2023" — the 01/01/2024 cutoff is a gate the rule cannot express, so
// a fixture relying on it would pass for a reason the rule does not have.
const rn007Clean: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 180500,
    sections: [
      { name: SECTION.principal, items: [{ description: "Saldo devedor", amountCents: 100000 }] },
      {
        name: SECTION.encargos,
        items: [
          { description: "Juros do rotativo", amountCents: 50000 },
          { description: "Multa e mora", amountCents: 20000 },
          { description: "Parcelamento do saldo", amountCents: 10000 },
        ],
      },
      { name: SECTION.iof, items: [{ description: "IOF", amountCents: 500 }] },
    ],
  }),
  previous: null,
};

// --- RN-008 — card, a registration-renewal fee -----------------------------
//
// The only rule here that matches on description. "Renovação" normalises to
// "RENOVACAO", which is what the pattern is written against.
const rn008Fires: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 51590,
    sections: [
      { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
      { name: SECTION.tarifas, items: [{ description: "Tarifa de Renovação de Cadastro", amountCents: 1590 }] },
    ],
  }),
  previous: null,
};

const rn008Clean: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 50000,
    sections: [{ name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] }],
  }),
  previous: null,
};

// --- RN-009 — card, two emergency credit assessments in one cycle ----------

const rn009Fires: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 60000,
    sections: [
      { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
      {
        name: SECTION.avaliacaoCredito,
        items: [
          { description: "Avaliação Emergencial de Crédito", amountCents: 5000, periodRef: "2026-06-05" },
          { description: "Avaliação Emergencial de Crédito", amountCents: 5000, periodRef: "2026-06-22" },
        ],
      },
    ],
  }),
  previous: null,
};

const rn009Clean: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 55000,
    sections: [
      { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
      {
        name: SECTION.avaliacaoCredito,
        items: [{ description: "Avaliação Emergencial de Crédito", amountCents: 5000, periodRef: "2026-06-05" }],
      },
    ],
  }),
  previous: null,
};

// --- RN-010, withdrawals — one item per withdrawal charged -----------------
//
// Five charged withdrawals against the four a conta corrente gets free; the
// clean invoice sits exactly on the limit, which must not fire.
const rn010SaquesFires: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 51250,
    sections: [
      { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
      {
        name: SECTION.saques,
        items: [
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-03" },
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-08" },
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-14" },
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-21" },
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-27" },
        ],
      },
    ],
  }),
  previous: null,
};

const rn010SaquesClean: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 51000,
    sections: [
      { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
      {
        name: SECTION.saques,
        items: [
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-03" },
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-08" },
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-14" },
          { description: "Saque em terminal de autoatendimento", amountCents: 250, periodRef: "2026-06-21" },
        ],
      },
    ],
  }),
  previous: null,
};

// --- RN-010, statements — the 2-a-month limit, same for both account types -

const rn010ExtratosFires: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 50600,
    sections: [
      { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
      {
        name: SECTION.extratos,
        items: [
          { description: "Extrato de conta", amountCents: 200, periodRef: "2026-06-05" },
          { description: "Extrato de conta", amountCents: 200, periodRef: "2026-06-15" },
          { description: "Extrato de conta", amountCents: 200, periodRef: "2026-06-25" },
        ],
      },
    ],
  }),
  previous: null,
};

const rn010ExtratosClean: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 50400,
    sections: [
      { name: SECTION.principal, items: [{ description: "Compras do período", amountCents: 50000 }] },
      {
        name: SECTION.extratos,
        items: [
          { description: "Extrato de conta", amountCents: 200, periodRef: "2026-06-05" },
          { description: "Extrato de conta", amountCents: 200, periodRef: "2026-06-15" },
        ],
      },
    ],
  }),
  previous: null,
};

// --- RN-011 — a package priced above the tariffs it replaces ---------------
//
// The "Tarifas Individuais Equivalentes" section is informational: it is
// what the bank *would* have charged item by item, so it is deliberately not
// part of `totalCents`. A real statement does not print it at all, which is
// the limitation `deterministic.ts` records for this rule.
const rn011Fires: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 3990,
    sections: [
      { name: SECTION.pacoteServicos, items: [{ description: "Pacote Essencial", amountCents: 3990 }] },
      {
        name: SECTION.tarifasIndividuais,
        items: [
          { description: "Extrato adicional (avulso)", amountCents: 1500 },
          { description: "Saque adicional (avulso)", amountCents: 1200 },
          { description: "Transferência entre contas (avulsa)", amountCents: 800 },
        ],
      },
    ],
  }),
  previous: null,
};

const rn011Clean: Scenario = {
  invoice: inv({
    issuer: CARD,
    period: JUNE,
    dueDate: "2026-07-10",
    totalCents: 2990,
    sections: [
      { name: SECTION.pacoteServicos, items: [{ description: "Pacote Essencial", amountCents: 2990 }] },
      {
        name: SECTION.tarifasIndividuais,
        items: [
          { description: "Extrato adicional (avulso)", amountCents: 1500 },
          { description: "Saque adicional (avulso)", amountCents: 1200 },
          { description: "Transferência entre contas (avulsa)", amountCents: 800 },
        ],
      },
    ],
  }),
  previous: null,
};

export const DETERMINISTIC_FIXTURES: Record<string, FixturePair> = {
  // 690 charged against a 600 cap.
  [RN_001]: { fires: rn001Fires, clean: rn001Clean, firesAmountCents: 90 },
  // A count of cycles, not money.
  [RN_002]: { fires: rn002Fires, clean: rn002Clean, firesAmountCents: 4 },
  // The smaller of the two summed lines.
  [RN_003]: { fires: rn003Fires, clean: rn003Clean, firesAmountCents: 1200 },
  // m³ of discrepancy, not money — `arithmetic.ts` names this exact case.
  [RN_004_CONSISTENCIA]: { fires: rn004ConsistenciaFires, clean: rn004ConsistenciaClean, firesAmountCents: 3 },
  // m³ the meter ran backwards.
  [RN_004_RETROCESSO]: { fires: rn004RetrocessoFires, clean: rn004RetrocessoClean, firesAmountCents: 5 },
  // `confirm` reports no amount; the finding is the question being answered "no".
  [RN_005]: { fires: rn005Fires, clean: rn005Clean, firesAmountCents: 0 },
  [RN_006]: { fires: rn006Fires, clean: rn006Clean, firesAmountCents: 0 },
  // 120000 of charges against a 100000 principal.
  [RN_007]: { fires: rn007Fires, clean: rn007Clean, firesAmountCents: 20000 },
  // The matched item's own value.
  [RN_008]: { fires: rn008Fires, clean: rn008Clean, firesAmountCents: 1590 },
  // Counts again, not money.
  [RN_009]: { fires: rn009Fires, clean: rn009Clean, firesAmountCents: 2 },
  [RN_010_SAQUES]: { fires: rn010SaquesFires, clean: rn010SaquesClean, firesAmountCents: 5 },
  [RN_010_EXTRATOS]: { fires: rn010ExtratosFires, clean: rn010ExtratosClean, firesAmountCents: 3 },
  // 3990 against a 3500 equivalent.
  [RN_011]: { fires: rn011Fires, clean: rn011Clean, firesAmountCents: 490 },
};
