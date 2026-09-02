import { describe, expect, it } from "vitest";
import {
  assembleContest, collectExpiredDeadlines, expiredDeadlineSentence, MANDATORY_SCRIPT_ITEMS,
  type CaseEventRecord, type CaseProtocolRecord,
} from "./assemble.js";
import { computeDeadline } from "../cases/deadline.js";
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

// ---------------------------------------------------------------------------
// RF-182 (E5 Task 5) — "Ao avançar por prazo vencido, o gerador recebe
// `deadlinesExpired` e o texto sai com canal, protocolo e datas."
//
// The acceptance is about the SENTENCE, not about the field having been
// passed: "documento contém a frase com número de protocolo e as duas
// datas". So every assertion below reads the produced string.
// ---------------------------------------------------------------------------

// 05/08/2026 12:00 in São Paulo (UTC-3) — mid-day, so no timezone reading of
// this instant could disagree about which day it is. The expiry instants
// below are deliberately the opposite: `computeDeadline` puts them at the
// last millisecond of the local day, which is the following morning in UTC.
const REGISTERED_AT = new Date("2026-08-05T15:00:00.000Z");
const SAC_EXPIRED_AT = computeDeadline({ startedAt: REGISTERED_AT, days: 7, businessDays: false }).expiresAt;

const SAC_PROTOCOL: CaseProtocolRecord = {
  stage: "sac",
  protocolNumber: "2026080512345",
  channel: "SAC da operadora",
  registeredAt: REGISTERED_AT,
  responseDueAt: SAC_EXPIRED_AT,
};

function expiryEvent(stage: string, occurredAt: Date): CaseEventRecord {
  return { type: "deadline_expired", occurredAt, payload: { stage } };
}

describe("RF-182 · expiredDeadlineSentence names the channel, the protocol and both dates", () => {
  const sentence = expiredDeadlineSentence({
    stage: "sac",
    channel: "SAC da operadora",
    protocolNumber: "2026080512345",
    registeredAt: REGISTERED_AT,
    expiredAt: SAC_EXPIRED_AT,
  });

  it("names the protocol number", () => {
    expect(sentence).toContain("2026080512345");
  });

  it("names the channel", () => {
    expect(sentence).toContain("SAC da operadora");
  });

  it("names the date the protocol was registered", () => {
    expect(sentence).toContain("05/08/2026");
  });

  // 05/08/2026 + 7 calendar days = 12/08/2026, a Wednesday, so no
  // roll-forward applies and the expected date is arithmetic, not a
  // restatement of what the calculator happened to return.
  it("names the date the deadline expired", () => {
    expect(sentence).toContain("12/08/2026");
  });

  // The regression `deadline.ts`'s third decision exists to prevent, pinned
  // where it would actually be printed. `expiresAt` is 23:59:59.999 in São
  // Paulo, which is 02:59:59.999 UTC the next morning — so a sentence built
  // from UTC calendar components names the wrong day on EVERY document, not
  // occasionally.
  it("does not print the expiry a day late by reading the instant in UTC", () => {
    expect(SAC_EXPIRED_AT.toISOString()).toContain("2026-08-13T02:59:59");
    expect(sentence).not.toContain("13/08/2026");
  });

  it("reads as one finished sentence, not a template with holes", () => {
    expect(sentence).toBe(
      "Protocolo 2026080512345, registrado no canal SAC da operadora em 05/08/2026: " +
      "o prazo de resposta terminou em 12/08/2026 sem resposta dentro do prazo.",
    );
  });
});

describe("RF-182 · collectExpiredDeadlines reads the expiry from events, never from a clock", () => {
  it("pairs a deadline_expired event with the protocol whose stage it names", () => {
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL],
      events: [expiryEvent("sac", new Date("2026-08-14T09:00:00.000Z"))],
    });
    expect(collected).toEqual([{
      stage: "sac",
      channel: "SAC da operadora",
      protocolNumber: "2026080512345",
      registeredAt: REGISTERED_AT,
      expiredAt: SAC_EXPIRED_AT,
    }]);
  });

  // The whole point of reading `events`. A protocol whose `responseDueAt` is
  // long past but which nothing ever declared expired produces nothing: the
  // decision that a deadline passed belongs to whoever made it, so a
  // document generated for some other reason cannot pick up an escalation
  // claim the case never made.
  it("produces nothing for a protocol nobody recorded an expiry for", () => {
    expect(collectExpiredDeadlines({ protocols: [SAC_PROTOCOL], events: [] })).toEqual([]);
  });

  it("ignores every event type other than deadline_expired", () => {
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL],
      events: [
        { type: "stage_advanced", occurredAt: new Date("2026-08-14T09:00:00.000Z"), payload: { stage: "sac" } },
        { type: "protocol_entered", occurredAt: new Date("2026-08-05T15:00:00.000Z"), payload: { stage: "sac" } },
      ],
    });
    expect(collected).toEqual([]);
  });

  // RF-186's stall: 30 days in which the person never wrote to the channel.
  // There is no protocol number and no company silence, so there is no
  // sentence to write — and inventing one would put a claim about a company
  // on a document with nothing behind it.
  it("produces nothing for an expiry on a stage with no protocol", () => {
    const collected = collectExpiredDeadlines({
      protocols: [],
      events: [expiryEvent("sac", new Date("2026-09-05T09:00:00.000Z"))],
    });
    expect(collected).toEqual([]);
  });

  // What this actually proves is that there is no fallback: an event that
  // does not name a stage this case has a protocol for contributes nothing,
  // rather than quietly attaching itself to whatever protocol is nearest.
  // (`"sca"` is not rejected by a vocabulary check — there is none, and one
  // would be dead code. It is rejected because no protocol carries it.)
  it("skips an event whose payload names no usable stage rather than guessing one", () => {
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL],
      events: [
        { type: "deadline_expired", occurredAt: new Date("2026-08-14T09:00:00.000Z"), payload: {} },
        { type: "deadline_expired", occurredAt: new Date("2026-08-14T09:00:00.000Z"), payload: { stage: "sca" } },
        { type: "deadline_expired", occurredAt: new Date("2026-08-14T09:00:00.000Z"), payload: null },
      ],
    });
    expect(collected).toEqual([]);
  });

  it("never pairs an expiry with a protocol registered for a different stage", () => {
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL],
      events: [expiryEvent("consumidor_gov", new Date("2026-09-20T09:00:00.000Z"))],
    });
    expect(collected).toEqual([]);
  });

  // A person who calls the SAC twice is waiting on the second protocol: that
  // is the number the channel itself will look up, and the one whose own
  // `responseDueAt` the wait was restarted from.
  it("uses the most recent protocol of that stage registered before the expiry", () => {
    const secondRegisteredAt = new Date("2026-08-10T15:00:00.000Z");
    const second: CaseProtocolRecord = {
      stage: "sac",
      protocolNumber: "2026081099999",
      channel: "SAC da operadora",
      registeredAt: secondRegisteredAt,
      responseDueAt: computeDeadline({ startedAt: secondRegisteredAt, days: 7, businessDays: false }).expiresAt,
    };
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL, second],
      events: [expiryEvent("sac", new Date("2026-08-18T09:00:00.000Z"))],
    });
    expect(collected).toHaveLength(1);
    expect(collected[0]?.protocolNumber).toBe("2026081099999");
    expect(expiredDeadlineSentence(collected[0]!)).toContain("17/08/2026");
  });

  it("never pairs an expiry with a protocol registered after it was recorded", () => {
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL],
      events: [expiryEvent("sac", new Date("2026-08-01T09:00:00.000Z"))],
    });
    expect(collected).toEqual([]);
  });

  it("records one entry per protocol, not one per duplicated event", () => {
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL],
      events: [
        expiryEvent("sac", new Date("2026-08-14T09:00:00.000Z")),
        expiryEvent("sac", new Date("2026-08-15T09:00:00.000Z")),
      ],
    });
    expect(collected).toHaveLength(1);
  });

  it("keeps every distinct expiry, in the order the events recorded them", () => {
    const govRegisteredAt = new Date("2026-08-20T15:00:00.000Z");
    const govProtocol: CaseProtocolRecord = {
      stage: "consumidor_gov",
      protocolNumber: "CG-778899",
      channel: "consumidor.gov.br",
      registeredAt: govRegisteredAt,
      responseDueAt: computeDeadline({ startedAt: govRegisteredAt, days: 10, businessDays: false }).expiresAt,
    };
    const collected = collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL, govProtocol],
      events: [
        expiryEvent("sac", new Date("2026-08-14T09:00:00.000Z")),
        expiryEvent("consumidor_gov", new Date("2026-09-01T09:00:00.000Z")),
      ],
    });
    expect(collected.map((entry) => entry.protocolNumber)).toEqual(["2026080512345", "CG-778899"]);
  });
});

describe("RF-182 · assembleContest carries the facts and the finished sentences", () => {
  const assembled = assembleContest({
    findings: [],
    stage: "consumidor_gov",
    playbook: TELECOM_PLAYBOOK,
    deadlinesExpired: collectExpiredDeadlines({
      protocols: [SAC_PROTOCOL],
      events: [expiryEvent("sac", new Date("2026-08-14T09:00:00.000Z"))],
    }),
  });

  // RF-182's literal wording: "o gerador recebe `deadlinesExpired`".
  it("carries the structured entries through to the generator", () => {
    expect(assembled.deadlinesExpired).toHaveLength(1);
    expect(assembled.deadlinesExpired[0]?.protocolNumber).toBe("2026080512345");
  });

  it("carries one finished sentence per expired deadline", () => {
    expect(assembled.escalationHistory).toHaveLength(1);
    expect(assembled.escalationHistory[0]).toContain("2026080512345");
    expect(assembled.escalationHistory[0]).toContain("SAC da operadora");
    expect(assembled.escalationHistory[0]).toContain("05/08/2026");
    expect(assembled.escalationHistory[0]).toContain("12/08/2026");
  });

  it("is empty on a case that is not escalating on an expiry", () => {
    const plain = assembleContest({ findings: [], stage: "sac", playbook: TELECOM_PLAYBOOK });
    expect(plain.deadlinesExpired).toEqual([]);
    expect(plain.escalationHistory).toEqual([]);
  });

  // Every sentence has to fit `ContestDocument.escalationHistory`'s own cap,
  // or a perfectly valid case would fail generation at the final parse. The
  // variable parts are user-typed, so the cap is tested against the longest
  // input the routes accept, not against the tidy fixture above.
  it("stays inside ContestDocument's 300-character cap for the longest accepted inputs", () => {
    const sentence = expiredDeadlineSentence({
      stage: "sac",
      channel: "C".repeat(120),
      protocolNumber: "9".repeat(60),
      registeredAt: REGISTERED_AT,
      expiredAt: SAC_EXPIRED_AT,
    });
    expect(sentence.length).toBeLessThanOrEqual(300);
  });
});
