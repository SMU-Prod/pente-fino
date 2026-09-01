import { describe, expect, it } from "vitest";
import { assembleContest, MANDATORY_SCRIPT_ITEMS } from "./assemble.js";
import type { Finding } from "../rules/finding.js";
import type { Playbook } from "../cases/playbook.js";
import type { LegalRef } from "../rules/spec.js";

function findingWith(legalBasis: LegalRef[], overrides: Partial<Finding> = {}): Finding {
  return {
    ruleSlug: "regra-teste",
    ruleVersion: 1,
    itemId: null,
    amountCents: 1000,
    doubledCents: null,
    confidence: 0.9,
    evidence: ["Encontramos R$ 10,00 para você verificar"],
    legalBasis,
    shadow: false,
    ...overrides,
  };
}

// This is the reference telecom playbook from PRD §20.2, trimmed to what
// these tests need. Every stage entry carries its own `legalRefs` — a field
// that RF-161 forbids `assembleContest` from ever touching, since it must
// answer only from the findings that actually fired. Its presence here is
// deliberate: several tests below try to smuggle it into the output.
const TELECOM_PLAYBOOK: Playbook = {
  stages: [
    {
      stage: "sac",
      channel: "SAC da operadora",
      responseDays: 7,
      businessDays: false,
      requiresPreviousProtocol: false,
      asks: [
        "número de protocolo",
        "suspensão imediata da cobrança contestada",
        "envio do histórico da demanda em 5 dias",
        "cópia da gravação do atendimento",
      ],
      legalRefs: [
        { law: "Decreto 11.034/2022", article: "art. 13 e §3º", effect: "suspensao" },
        { law: "Decreto 11.034/2022", article: "art. 12, §2º e §3º", effect: "limite" },
      ],
    },
    {
      stage: "consumidor_gov",
      channel: "consumidor.gov.br",
      deepLink: "https://www.consumidor.gov.br/pages/reclamacao/abrir",
      responseDays: 10,
      businessDays: false,
      requiresPreviousProtocol: true,
      asks: ["estorno em dobro com correção", "cancelamento com efeito imediato"],
      legalRefs: [{ law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" }],
    },
  ],
};

const CDC_ART_42: LegalRef = { law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" };
const CDC_ART_39: LegalRef = { law: "CDC", article: "art. 39, III, p.u.", effect: "vedada" };

describe("assembleContest · RF-161 legal references", () => {
  it("collects legalRefs from every finding's own legalBasis", () => {
    const findings = [findingWith([CDC_ART_39]), findingWith([CDC_ART_42])];
    const result = assembleContest({ findings, stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(result.legalRefs).toEqual([CDC_ART_39, CDC_ART_42]);
  });

  it("returns no legalRefs when there are no findings", () => {
    const result = assembleContest({ findings: [], stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(result.legalRefs).toEqual([]);
  });

  it("dedupes an identical legalRef repeated across findings", () => {
    const findings = [findingWith([CDC_ART_39]), findingWith([CDC_ART_39])];
    const result = assembleContest({ findings, stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(result.legalRefs).toEqual([CDC_ART_39]);
  });

  it("dedupes a legalRef that differs from another only in whitespace or case", () => {
    const shouted: LegalRef = {
      law: "cdc",
      article: "ART.   39,   III,  P.U.",
      effect: "vedada",
    };
    const findings = [findingWith([CDC_ART_39]), findingWith([shouted])];
    const result = assembleContest({ findings, stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(result.legalRefs).toHaveLength(1);
  });

  it("never draws a legalRef from the playbook's own per-stage legalRefs field", () => {
    // TELECOM_PLAYBOOK's "consumidor_gov" entry carries CDC_ART_42 in its own
    // legalRefs, and no finding here supplies it. If assembleContest ever
    // reads playbook.stages[...].legalRefs instead of only finding.legalBasis,
    // this is the test that catches it.
    const result = assembleContest({
      findings: [findingWith([CDC_ART_39])],
      stage: "consumidor_gov",
      playbook: TELECOM_PLAYBOOK,
    });
    expect(result.legalRefs).toEqual([CDC_ART_39]);
    expect(result.legalRefs).not.toContainEqual(CDC_ART_42);
  });

  it("never invents a legalRef out of an empty finding list, even for a stage whose playbook entry has its own", () => {
    const result = assembleContest({
      findings: [],
      stage: "consumidor_gov",
      playbook: TELECOM_PLAYBOOK,
    });
    expect(result.legalRefs).toEqual([]);
  });
});

describe("assembleContest · the stage's asks, from the playbook", () => {
  it("returns the matching stage's asks verbatim", () => {
    const result = assembleContest({ findings: [], stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(result.asks).toEqual([
      "número de protocolo",
      "suspensão imediata da cobrança contestada",
      "envio do histórico da demanda em 5 dias",
      "cópia da gravação do atendimento",
    ]);
  });

  it("returns no asks when the playbook has no entry for the stage", () => {
    const result = assembleContest({ findings: [], stage: "regulator", playbook: TELECOM_PLAYBOOK });
    expect(result.asks).toEqual([]);
  });
});

describe("assembleContest · RF-165 attachment checklist", () => {
  it("lists the invoice, the previous protocol and a screenshot of the conversation for consumidor_gov", () => {
    const result = assembleContest({
      findings: [],
      stage: "consumidor_gov",
      playbook: TELECOM_PLAYBOOK,
    });
    const checklist = result.attachmentsChecklist.join(" | ").toLowerCase();
    expect(checklist).toContain("fatura");
    expect(checklist).toContain("protocolo anterior");
    expect(checklist).toContain("print");
    expect(checklist).toContain("conversa");
  });

  it("lists only the invoice for a stage that does not require a previous protocol", () => {
    const result = assembleContest({ findings: [], stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(result.attachmentsChecklist).toEqual(["Fatura do período contestado"]);
  });

  it("falls back to the base invoice item when the playbook has no entry for the stage", () => {
    const result = assembleContest({ findings: [], stage: "regulator", playbook: TELECOM_PLAYBOOK });
    expect(result.attachmentsChecklist).toEqual(["Fatura do período contestado"]);
  });
});

describe("assembleContest · RF-163 mandatory script items", () => {
  it("always asks for the protocol number and for the call recording", () => {
    const result = assembleContest({ findings: [], stage: "sac", playbook: TELECOM_PLAYBOOK });
    const script = result.mandatoryScriptItems.join(" | ").toLowerCase();
    expect(script).toContain("protocolo");
    expect(script).toContain("gravação");
    expect(result.mandatoryScriptItems).toEqual([...MANDATORY_SCRIPT_ITEMS]);
  });

  it("still includes both mandatory items for a stage absent from the playbook", () => {
    const result = assembleContest({ findings: [], stage: "procon", playbook: TELECOM_PLAYBOOK });
    expect(result.mandatoryScriptItems).toEqual([...MANDATORY_SCRIPT_ITEMS]);
  });

  it("still includes both mandatory items for an empty playbook", () => {
    const result = assembleContest({ findings: [], stage: "sac", playbook: { stages: [] } });
    expect(result.mandatoryScriptItems).toEqual([...MANDATORY_SCRIPT_ITEMS]);
  });
});

describe("assembleContest · protocols already recorded", () => {
  it("passes recorded protocols through unchanged, for the generator to reference", () => {
    const protocols = [{ stage: "sac" as const, protocolNumber: "123456", channel: "SAC da operadora" }];
    const result = assembleContest({
      findings: [],
      stage: "consumidor_gov",
      playbook: TELECOM_PLAYBOOK,
      protocols,
    });
    expect(result.protocols).toEqual(protocols);
  });

  it("defaults to an empty list when no protocols are given", () => {
    const result = assembleContest({ findings: [], stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(result.protocols).toEqual([]);
  });
});

describe("assembleContest · echoes the requested stage", () => {
  it("carries the stage it was called with", () => {
    const result = assembleContest({ findings: [], stage: "ombudsman", playbook: TELECOM_PLAYBOOK });
    expect(result.stage).toBe("ombudsman");
  });
});
