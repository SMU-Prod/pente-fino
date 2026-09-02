import { describe, expect, it } from "vitest";
import { assembleContest } from "@pentefino/core";
import type { Finding, Playbook } from "@pentefino/core";
import type { LegalRef } from "@pentefino/core";
import type { AiUsage } from "@pentefino/core/ports";
import {
  ContestDraft,
  ContestGenerationError,
  generateContestDocument,
  type ContestPromptInput,
  type GenerateContestFn,
} from "./contest.js";
import { CONTEST_PROMPT_V1 } from "./prompts/contest.v1.js";

function findingWith(legalBasis: LegalRef[], overrides: Partial<Finding> = {}): Finding {
  return {
    ruleSlug: "regra-teste",
    ruleVersion: 1,
    itemId: null,
    amountCents: 2545,
    doubledCents: null,
    confidence: 0.9,
    evidence: ["Encontramos R$ 25,45 no pacote adicional para você verificar"],
    legalBasis,
    shadow: false,
    ...overrides,
  };
}

// Trimmed from PRD §20.2, the same reference playbook `assemble.test.ts`
// (Task 1) uses.
const TELECOM_PLAYBOOK: Playbook = {
  stages: [
    {
      stage: "sac",
      channel: "SAC da operadora",
      responseDays: 7,
      businessDays: false,
      requiresPreviousProtocol: false,
      asks: ["número de protocolo", "suspensão imediata da cobrança contestada"],
      legalRefs: [{ law: "Decreto 11.034/2022", article: "art. 13 e §3º", effect: "suspensao" }],
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

const CDC_ART_39: LegalRef = { law: "CDC", article: "art. 39, III, p.u.", effect: "vedada" };

const PROMPT_BODY = CONTEST_PROMPT_V1.body;

const FAKE_USAGE: AiUsage = {
  tokensIn: 400,
  tokensOut: 180,
  costUsd: 0.0021,
  latencyMs: 850,
  model: "fixture",
  provider: "fixture",
};

// A genuine, first-person, > 200 char body — every "happy path" test below
// uses this exact draft, so a test failure always points at the gate logic,
// never at an accidentally-too-short fixture string.
const CLEAN_BODY =
  "Solicito a revisão da cobrança do pacote adicional que não reconheço na fatura deste mês, referente " +
  "à linha (11) 98765-4321. Não autorizei a contratação desse serviço e peço o cancelamento imediato, " +
  "além da devolução do valor cobrado indevidamente. Recebi esta fatura em agosto de 2026 e gostaria de " +
  "resolver esta situação o quanto antes, mantendo meu histórico de pagamentos em dia com esta operadora " +
  "há mais de três anos.";

const CLEAN_DRAFT: ContestDraft = {
  subject: "Contestação de cobrança — pacote adicional não reconhecido",
  body: CLEAN_BODY,
  scriptForCall: ["Explique que a cobrança de R$ 25,45 do pacote adicional não foi reconhecida."],
};

// RF-162's own forced fixture: same shape as CLEAN_DRAFT, but the body
// names the exact forbidden term the acceptance names ("advogado").
const TAINTED_BODY =
  "Meu advogado revisou esta fatura e não reconheço a cobrança do pacote adicional na fatura deste mês, " +
  "referente à linha (11) 98765-4321. Peço o cancelamento imediato e a devolução do valor cobrado. " +
  "Recebi esta fatura em agosto de 2026 e quero resolver isso o quanto antes.";

const TAINTED_DRAFT: ContestDraft = {
  subject: "Contestação de cobrança",
  body: TAINTED_BODY,
  scriptForCall: ["Peça o número de protocolo do atendimento."],
};

function assembledSac() {
  return assembleContest({
    findings: [findingWith([CDC_ART_39])],
    stage: "sac",
    playbook: TELECOM_PLAYBOOK,
  });
}

function baseInput(): ContestPromptInput {
  return {
    issuerName: "Claro Móvel",
    assembled: assembledSac(),
    findings: [{ evidence: ["Encontramos R$ 25,45 no pacote adicional para você verificar"], amountCents: 2545, doubledCents: null }],
  };
}

function fixedGenerate(draft: unknown): GenerateContestFn {
  return async () => ({ draft, usage: FAKE_USAGE });
}

function sequenceGenerate(drafts: unknown[]): GenerateContestFn {
  let call = 0;
  return async () => {
    const draft = drafts[Math.min(call, drafts.length - 1)];
    call += 1;
    return { draft, usage: FAKE_USAGE };
  };
}

describe("ContestDraft", () => {
  it("accepts subject, body and scriptForCall, with no legalRefs/requests/attachmentsChecklist fields required or accepted as data", () => {
    const parsed = ContestDraft.parse(CLEAN_DRAFT);
    expect(parsed).toEqual(CLEAN_DRAFT);
  });

  it("rejects a draft missing body", () => {
    expect(ContestDraft.safeParse({ subject: "x", scriptForCall: ["y"] }).success).toBe(false);
  });

  it("rejects a draft with an empty scriptForCall", () => {
    expect(ContestDraft.safeParse({ ...CLEAN_DRAFT, scriptForCall: [] }).success).toBe(false);
  });

  it("strips an unknown legalRefs key rather than trusting it", () => {
    const parsed = ContestDraft.parse({ ...CLEAN_DRAFT, legalRefs: [{ law: "Lei Inventada", article: "art. 1" }] });
    expect(parsed).not.toHaveProperty("legalRefs");
  });
});

describe("generateContestDocument · RF-160 schema gate", () => {
  it("regenerates once when the first attempt fails schema validation, and succeeds with the second", async () => {
    const generate = sequenceGenerate([{ subject: "só isso" }, CLEAN_DRAFT]);
    const { document, usages } = await generateContestDocument(baseInput(), PROMPT_BODY, generate);
    expect(document.body).toBe(CLEAN_BODY);
    expect(usages).toHaveLength(2);
  });

  it("throws a clear ContestGenerationError when the schema fails on both attempts, never returning a partial document", async () => {
    const generate = fixedGenerate({ subject: "só isso" });
    const error: unknown = await generateContestDocument(baseInput(), PROMPT_BODY, generate).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContestGenerationError);
    expect((error as ContestGenerationError).reason).toBe("generation_failed");
  });
});

describe("generateContestDocument · RF-162 lint gate (forced fixture)", () => {
  it("rejects a document containing \"advogado\" and regenerates once, succeeding with the clean draft", async () => {
    const generate = sequenceGenerate([TAINTED_DRAFT, CLEAN_DRAFT]);
    const { document, usages } = await generateContestDocument(baseInput(), PROMPT_BODY, generate);
    expect(document.body).toBe(CLEAN_BODY);
    expect(document.body.toLowerCase()).not.toContain("advogado");
    expect(usages).toHaveLength(2);
  });

  it("throws when \"advogado\" appears in both attempts, never displaying the tainted document", async () => {
    const generate = fixedGenerate(TAINTED_DRAFT);
    const error: unknown = await generateContestDocument(baseInput(), PROMPT_BODY, generate).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContestGenerationError);
    expect((error as ContestGenerationError).reason).toBe("generation_failed");
    expect((error as Error).message).toContain("advogado");
  });
});

describe("generateContestDocument · RF-161 legal references never come from the model", () => {
  it("attaches only the findings' own legal basis, ignoring anything the draft tries to add", async () => {
    const generate = fixedGenerate({ ...CLEAN_DRAFT, legalRefs: [{ law: "Lei Inventada", article: "art. 1" }] });
    const { document } = await generateContestDocument(baseInput(), PROMPT_BODY, generate);
    expect(document.legalRefs).toEqual([{ law: "CDC", article: "art. 39, III, p.u." }]);
  });

  it("carries no legal reference at all when the findings carry none", async () => {
    const input: ContestPromptInput = {
      issuerName: "Claro Móvel",
      assembled: assembleContest({ findings: [], stage: "sac", playbook: TELECOM_PLAYBOOK }),
      findings: [],
    };
    const generate = fixedGenerate(CLEAN_DRAFT);
    const { document } = await generateContestDocument(input, PROMPT_BODY, generate);
    expect(document.legalRefs).toEqual([]);
  });
});

describe("generateContestDocument · without a key, it refuses visibly and never assembles templated prose", () => {
  it("throws immediately when no generate function is supplied", async () => {
    const error: unknown = await generateContestDocument(baseInput(), PROMPT_BODY, undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContestGenerationError);
    expect((error as ContestGenerationError).reason).toBe("not_configured");
  });
});

describe("generateContestDocument · a stage with no playbook asks refuses rather than inventing requests", () => {
  it("throws before ever calling generate", async () => {
    let called = false;
    const generate: GenerateContestFn = async () => {
      called = true;
      return { draft: CLEAN_DRAFT, usage: FAKE_USAGE };
    };
    const input: ContestPromptInput = {
      issuerName: "Claro Móvel",
      assembled: assembleContest({ findings: [], stage: "ombudsman", playbook: TELECOM_PLAYBOOK }),
      findings: [],
    };
    const error: unknown = await generateContestDocument(input, PROMPT_BODY, generate).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContestGenerationError);
    expect((error as ContestGenerationError).reason).toBe("no_asks");
    expect(called).toBe(false);
  });
});

describe("generateContestDocument · deterministic fields are attached verbatim, never left to the model", () => {
  it("requests come from the playbook's own asks for the stage, verbatim", async () => {
    const generate = fixedGenerate(CLEAN_DRAFT);
    const input = baseInput();
    const { document } = await generateContestDocument(input, PROMPT_BODY, generate);
    expect(document.requests).toEqual(input.assembled.asks);
  });

  it("attachmentsChecklist comes from assembleContest's own checklist for the stage, verbatim", async () => {
    const input: ContestPromptInput = {
      issuerName: "Claro Móvel",
      assembled: assembleContest({
        findings: [findingWith([CDC_ART_39])],
        stage: "consumidor_gov",
        playbook: TELECOM_PLAYBOOK,
      }),
      findings: [],
    };
    const generate = fixedGenerate(CLEAN_DRAFT);
    const { document } = await generateContestDocument(input, PROMPT_BODY, generate);
    expect(document.attachmentsChecklist).toEqual(input.assembled.attachmentsChecklist);
    expect(document.attachmentsChecklist.join(" ").toLowerCase()).toContain("protocolo anterior");
  });

  it("scriptForCall always has at least 3 items, including the protocol and recording requests (RF-163)", async () => {
    const generate = fixedGenerate(CLEAN_DRAFT);
    const { document } = await generateContestDocument(baseInput(), PROMPT_BODY, generate);
    expect(document.scriptForCall.length).toBeGreaterThanOrEqual(3);
    const joined = document.scriptForCall.join(" | ").toLowerCase();
    expect(joined).toContain("protocolo");
    expect(joined).toContain("gravação");
  });

  it("the returned document is itself a valid ContestDocument (defense in depth, A7)", async () => {
    const generate = fixedGenerate(CLEAN_DRAFT);
    const { document } = await generateContestDocument(baseInput(), PROMPT_BODY, generate);
    const { ContestDocument } = await import("@pentefino/core");
    expect(() => ContestDocument.parse(document)).not.toThrow();
  });
});
