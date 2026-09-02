import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ContestDocument, Playbook } from "@pentefino/core";

// ---------------------------------------------------------------------------
// INV-003 — "Nunca redigir peça apresentando o sistema como autor ou
// representante" (PRD §3). §16.3 names this exact file; it never existed
// before this block because there was no document to constrain.
//
// The document this suite guards is written in the FIRST PERSON — that is
// the whole point. "Solicito o cancelamento", "não reconheço esta cobrança",
// "recebi a fatura em" are the person's own voice, and are exactly what the
// product exists to help someone write. What INV-003 forbids is a narrower,
// specific thing: the INSTITUTIONAL first person plural — the system placing
// *itself* inside the consumer procedure, as PRD §14.2's paired example
// shows ("Nós entramos com a reclamação" vs. the approved "Texto pronto para
// você enviar"), and as §1.5 states permanently: "qualquer forma de
// representação do usuário" is out of scope.
//
// --- Where the line falls, and why -----------------------------------------
//
// This is deliberately NOT "flag every verb conjugated in the first person
// plural". A genuinely plural person exists — a household writing together
// ("Nós, moradores desta residência, solicitamos o cancelamento..."). That
// person's "solicitamos", "reconhecemos", "pagamos", "somos" describe what
// THEY do and what THEY are; flagging those would fail the brief's own
// warning that a check too tight rejects the very sentences the product
// exists to help someone write.
//
// What actually marks institutional voice is not the grammatical person —
// it is *which action* the plural subject claims. `INSTITUTIONAL_TERMS`
// below is a closed, literal phrase list — the same choice §14.3's own
// vocabulary makes, and the same one `forbidden-terms.ts` makes for
// "garantimos"/"garantia de" instead of conjugating "garantir" generically
// — built from three shapes, and only these three:
//
//   1. Filing the complaint/lawsuit itself as the system's own act
//      (entrar com, protocolar, mover, ingressar + the procedural object:
//      a reclamação/o processo/a ação). The object is required, not
//      decorative: "entrar com" alone is also how a person would phrase
//      "entrar em contato" or "entrar com os documentos" about their own,
//      legitimate act — it is the object that turns it into the system
//      filing the person's case for them.
//   2. Explicit representation (representar, "em seu nome", "como
//      representante") — no object needed, since the phrase itself already
//      asserts the system stands in for the person, which §1.5 rules out
//      permanently.
//   3. Taking over the case as an ongoing actor rather than handing the
//      person a text to send (acompanhar o caso/processo, cuidar do caso,
//      resolver o problema, prosseguir com a reclamação), plus the
//      institution naming its own staff or premises inside the procedure
//      ("nossa equipe jurídica", "nosso escritório").
//
// A household's "solicitamos" or "pagamos" never appears here: requesting
// and paying are things the consumer does themself, not things an agent
// does on their behalf. That is the line this suite enforces, and the
// "stays legal" tests below prove it holds for exactly that edge case.
// ---------------------------------------------------------------------------

const INSTITUTIONAL_TERMS = [
  // (1) Filing the complaint/lawsuit itself — verb + the procedural object
  // that makes it the system's own act, across the tenses a generated or
  // hand-written sentence would realistically use: present, simple future,
  // and the periphrastic "vamos/iremos + infinitive" future.
  "entramos com a reclamação", "entraremos com a reclamação",
  "vamos entrar com a reclamação", "iremos entrar com a reclamação",
  "entramos com o processo", "entraremos com o processo",
  "entramos com a ação", "entraremos com a ação",
  "movemos a ação", "moveremos a ação", "vamos mover a ação",
  "protocolamos a reclamação", "protocolaremos a reclamação",
  "protocolamos o processo", "protocolaremos o processo",
  "ingressamos com a ação", "ingressaremos com a ação", "vamos ingressar com a ação",

  // (2) Explicit representation — the phrase itself already asserts the
  // system stands in for the person; no procedural object required.
  "representamos você", "representamos o consumidor", "representaremos você",
  "em seu nome", "em nome de você", "em nome do consumidor", "em nome da pessoa consumidora",
  "como seu representante", "como seus representantes",
  "como representante legal", "na qualidade de representante",
  "atuamos como seu representante", "atuamos como representantes",
  "atuaremos em seu nome", "atuamos em seu nome",

  // (3) Taking over the case as an ongoing actor, rather than handing the
  // person a text to send — object required, same reasoning as group (1).
  "acompanhamos o seu caso", "acompanharemos o seu caso",
  "acompanhamos o seu processo", "acompanharemos o seu processo",
  "cuidamos do seu caso", "cuidaremos do seu caso",
  "cuidamos do seu processo", "cuidaremos do seu processo",
  "resolvemos isso para você", "resolveremos isso para você",
  "resolveremos o seu problema", "vamos resolver o seu problema",
  "prosseguimos com a reclamação", "prosseguiremos com a reclamação",
  "prosseguimos com o processo", "prosseguiremos com o processo",

  // The institution naming its own staff or premises inside the procedure —
  // "nosso"/"nossa" is still the first person plural §3 names even where the
  // finite verb that follows is not itself plural ("nossa equipe jurídica
  // acompanhará..." conjugates "acompanhar" in the third person singular,
  // but "nossa" is the institution speaking about itself).
  "nossa equipe jurídica", "nosso departamento jurídico", "nossa assessoria jurídica",
  "nossos advogados", "nossas advogadas", "nosso escritório de advocacia",
  "nosso time cuida do seu caso", "nosso time cuidará do seu caso",
  "nossa plataforma entra com", "nossa plataforma entrará com", "nossa plataforma representa",
] as const;

function fold(text: string): string {
  // U+0300-U+036F is the Unicode "Combining Diacritical Marks" block,
  // written as an escaped range rather than literal combining characters —
  // see packages/ai/src/lint.ts's identical choice, made for the same
  // reason: a literal combining character in this file has silently
  // corrupted this file family before.
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Whole-phrase, whitespace-flexible matcher: splits `phrase` on its literal
 * spaces and rejoins with `\s+`, so a line break or a run of extra
 * whitespace between words in generated prose still counts as the phrase —
 * the same choice `packages/ai/src/lint.ts`'s `findWord` makes for §14.3's
 * own multi-word terms. Unicode-aware word-boundary lookaround stops a bare
 * prefix match: "entramos com a reclamação anterior" still counts, but
 * "reentramos com a reclamação" (a different word) does not.
 */
function containsPhrase(foldedHaystack: string, phrase: string): boolean {
  const words = fold(phrase).split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = words.join("\\s+");
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "u");
  return regex.test(foldedHaystack);
}

/** Every institutional-voice term found in `text` (accent- and case-insensitive), as the original listed phrase. */
function institutionalVoiceHits(text: string): string[] {
  const folded = fold(text);
  return INSTITUTIONAL_TERMS.filter((term) => containsPhrase(folded, term));
}

/**
 * Sweeps exactly the surface RF-162 already names for the lint gate —
 * subject, body, each request, each scriptForCall line, each attachment
 * label — so INV-003 covers the same fields INV-004/INV-005 do, not a
 * narrower one. `legalRefs` is deliberately not swept: it is structured
 * law/article data, not prose, and RF-161's own guarantee (only the
 * findings' legal basis, never invented) is Task 1's concern, not this one's.
 */
function institutionalVoiceViolations(doc: ContestDocument): Array<{ field: string; term: string }> {
  const violations: Array<{ field: string; term: string }> = [];
  const sweep = (field: string, text: string): void => {
    for (const term of institutionalVoiceHits(text)) violations.push({ field, term });
  };
  sweep("subject", doc.subject);
  sweep("body", doc.body);
  doc.requests.forEach((request, i) => sweep(`requests[${i}]`, request));
  doc.scriptForCall.forEach((line, i) => sweep(`scriptForCall[${i}]`, line));
  doc.attachmentsChecklist.forEach((label, i) => sweep(`attachmentsChecklist[${i}]`, label));
  // E5 Task 5's RF-182 field, swept because it is prose the document shows.
  // `?? []` rather than a required read: the field is optional on purpose
  // (see `contest.ts`), because a `case_documents.body` written before E5
  // genuinely does not carry it.
  (doc.escalationHistory ?? []).forEach((line, i) => sweep(`escalationHistory[${i}]`, line));
  return violations;
}

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** Reads a file, or `null` if it does not exist yet — distinct from any other read failure, which still throws. */
function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

describe("INV-003 · vocabulary sanity", () => {
  it("has institutional-voice terms to check — not an empty list", () => {
    expect(INSTITUTIONAL_TERMS.length).toBeGreaterThan(20);
  });

  it("every listed term is itself caught by the detector", () => {
    for (const term of INSTITUTIONAL_TERMS) {
      expect(institutionalVoiceHits(`Texto com ${term} no meio.`)).toContain(term);
    }
  });
});

describe("INV-003 · every institutional-voice term is caught", () => {
  for (const term of INSTITUTIONAL_TERMS) {
    it(`rejects "${term}"`, () => {
      expect(institutionalVoiceHits(`Texto com ${term} no meio.`)).toContain(term);
    });
  }
});

describe("INV-003 · the person's own first person stays legal — singular voice", () => {
  for (const sentence of [
    "Solicito o cancelamento imediato da linha.",
    "Não reconheço esta cobrança na fatura.",
    "Recebi a fatura em 05/08/2026 com um valor que não reconheço.",
    "Peço a devolução do valor cobrado sem autorização.",
    "Não autorizei a contratação deste serviço adicional.",
  ]) {
    it(`accepts "${sentence}"`, () => {
      expect(institutionalVoiceHits(sentence)).toEqual([]);
    });
  }
});

// The edge case the brief calls out explicitly: a person who *is* plural —
// a household writing together — is still the document's own author, not
// the system. None of "solicitamos"/"reconhecemos"/"pagamos"/"somos" is in
// `INSTITUTIONAL_TERMS`, because none of them is a procedural or
// representational act an agent performs *for* the household — they
// describe what the household itself does and is.
describe("INV-003 · the person's own first person stays legal — household plural", () => {
  for (const sentence of [
    "Nós, moradores desta residência, solicitamos o cancelamento do serviço adicional e não reconhecemos a cobrança de R$ 25,45.",
    "Somos os titulares da linha e pagamos essa fatura todo mês; não reconhecemos este valor extra.",
    "Solicitamos o reembolso do valor cobrado sem nossa autorização.",
  ]) {
    it(`accepts "${sentence}"`, () => {
      expect(institutionalVoiceHits(sentence)).toEqual([]);
    });
  }
});

describe("INV-003 · proof: an institutional-voice document is caught in every RF-162 field", () => {
  // One tainted entry per field kind RF-162 sweeps, so this proves the
  // check is not vacuous in any of the five places it has to look, not just
  // the one place it might be easiest to write a detector for.
  const TAINTED_DOCUMENT: ContestDocument = {
    subject: "Contestação — nossa equipe jurídica atua no seu caso",
    body: "Nós entramos com a reclamação referente à cobrança de R$ 25,45 do pacote adicional não contratado.",
    requests: [
      "Estorno em dobro do valor cobrado.",
      "Representamos você até a solução final junto à operadora.",
    ],
    legalRefs: [{ law: "CDC", article: "art. 42, parágrafo único" }],
    scriptForCall: [
      "Peça o número de protocolo do atendimento.",
      "Nosso time cuidará do seu caso a partir de agora.",
    ],
    attachmentsChecklist: [
      "Fatura do mês em questão.",
      "Nosso escritório de advocacia anexará o protocolo anterior.",
    ],
    escalationHistory: [
      "Protocolo 2024123456, registrado no canal SAC da operadora em 05/08/2026.",
      "Acompanhamos o seu caso desde que o prazo terminou em 12/08/2026.",
    ],
  };

  it("fails: catches exactly the tainted field, in every field kind", () => {
    expect(institutionalVoiceViolations(TAINTED_DOCUMENT)).toEqual([
      { field: "subject", term: "nossa equipe jurídica" },
      { field: "body", term: "entramos com a reclamação" },
      { field: "requests[1]", term: "representamos você" },
      { field: "scriptForCall[1]", term: "nosso time cuidará do seu caso" },
      { field: "attachmentsChecklist[1]", term: "nosso escritório de advocacia" },
      { field: "escalationHistory[1]", term: "acompanhamos o seu caso" },
    ]);
  });

  // The companion proof that the check is not too tight: the same shape of
  // document, written correctly in the person's own voice, has zero
  // violations across the same five fields.
  const CLEAN_DOCUMENT: ContestDocument = {
    subject: "Contestação de cobrança — Linha (11) 98765-4321",
    body: "Solicito o cancelamento imediato do serviço adicional e não reconheço a cobrança de R$ 25,45 na fatura de agosto. Recebi a fatura em 05/08/2026 e não autorizei essa contratação.",
    requests: [
      "Estorno em dobro do valor cobrado.",
      "Cancelamento imediato do serviço adicional.",
    ],
    legalRefs: [{ law: "CDC", article: "art. 42, parágrafo único" }],
    scriptForCall: [
      "Peça o número de protocolo do atendimento.",
      "Solicite a cópia da gravação da ligação.",
    ],
    attachmentsChecklist: [
      "Fatura do mês em questão.",
      "Protocolo do atendimento anterior.",
    ],
    // The real sentence `expiredDeadlineSentence` produces (RF-182). It
    // states a fact about the person's own protocol and is not the system
    // placing itself inside the procedure, so it must pass — this is the
    // "not too tight" half of the proof for the new field.
    escalationHistory: [
      "Protocolo 2024123456, registrado no canal SAC da operadora em 05/08/2026: " +
        "o prazo de resposta terminou em 12/08/2026 sem resposta dentro do prazo.",
    ],
  };

  it("passes: the same document shape, written in the person's own voice, has zero violations", () => {
    expect(institutionalVoiceViolations(CLEAN_DOCUMENT)).toEqual([]);
  });
});

describe("INV-003 · Task 1's deterministic document strings (RF-161/RF-163/RF-165)", () => {
  // §20.2's playbook literal and RF-165's acceptance checklist are the exact
  // data `packages/core/src/documents/assemble.ts` (Task 1, building in
  // parallel in this same block) surfaces into a `ContestDocument`
  // untouched — the brief for that task says so explicitly ("the stage's
  // asks... are requirements of the document, not suggestions to a model").
  // Checking this source data now, rather than waiting on assemble.ts's
  // function signature to land, is meaningful today: it is the actual risk
  // surface. A playbook ask or attachment label written in institutional
  // voice would flow into every document that stage ever produces.
  const TELECOM_PLAYBOOK: Playbook = {
    stages: [
      {
        stage: "sac", channel: "SAC da operadora", responseDays: 7,
        businessDays: false, requiresPreviousProtocol: false,
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
        stage: "consumidor_gov", channel: "consumidor.gov.br",
        deepLink: "https://www.consumidor.gov.br/pages/reclamacao/abrir",
        responseDays: 10, businessDays: false, requiresPreviousProtocol: true,
        asks: ["estorno em dobro com correção", "cancelamento com efeito imediato"],
        legalRefs: [{ law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" }],
      },
      {
        stage: "regulator", channel: "Anatel", responseDays: 5, businessDays: true,
        requiresPreviousProtocol: true,
        asks: [
          "cobrança apenas da parte incontroversa",
          "novo boleto sem custo",
          "devolução em dobro",
        ],
        legalRefs: [
          { law: "Res. Anatel 765/2023", article: "arts. 60 a 62", effect: "suspensao" },
          { law: "Res. Anatel 765/2023", article: "art. 64", effect: "dobro" },
        ],
      },
      {
        stage: "jec_ready", channel: "Juizado Especial Cível", responseDays: 0,
        businessDays: false, requiresPreviousProtocol: true,
        asks: ["dossiê cronológico completo"], legalRefs: [],
      },
    ],
  };

  // RF-165's own acceptance: the `consumidor_gov` stage's checklist names
  // the invoice, the previous protocol and a screenshot of the conversation.
  const CONSUMIDOR_GOV_ATTACHMENTS = ["fatura", "protocolo anterior", "print da conversa"];

  it("has playbook and attachment-checklist strings to check — not an empty fixture", () => {
    const askCount = TELECOM_PLAYBOOK.stages.reduce((total, stage) => total + stage.asks.length, 0);
    expect(askCount).toBeGreaterThan(0);
    expect(CONSUMIDOR_GOV_ATTACHMENTS.length).toBeGreaterThan(0);
  });

  it("finds no institutional voice in any of §20.2's playbook asks, across every stage", () => {
    const offenders: Array<{ stage: string; ask: string; term: string }> = [];
    for (const stage of TELECOM_PLAYBOOK.stages) {
      for (const ask of stage.asks) {
        for (const term of institutionalVoiceHits(ask)) offenders.push({ stage: stage.stage, ask, term });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds no institutional voice in any legalRefs law/article/note text", () => {
    const offenders: string[] = [];
    for (const stage of TELECOM_PLAYBOOK.stages) {
      for (const ref of stage.legalRefs) {
        for (const value of [ref.law, ref.article, ref.note]) {
          if (typeof value === "string") offenders.push(...institutionalVoiceHits(value));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds no institutional voice in RF-165's consumidor_gov attachment checklist", () => {
    expect(CONSUMIDOR_GOV_ATTACHMENTS.flatMap((label) => institutionalVoiceHits(label))).toEqual([]);
  });

  // Defense in depth, the same shape `packages/db/test/invariants/
  // suppressors.spec.ts` uses for a dependency that has not landed yet: run
  // the real check when the real file exists, and assert an explicit
  // pending marker — never a silent skip — when it does not. The moment
  // Task 1 lands `assemble.ts` in this branch, this test starts scanning
  // its actual literal strings, with no edit to this file required.
  //
  // (A whole-file text scan, not an executed import: Task 1's exported
  // function names and signature are not yet known from here, and a raw
  // text scan needs none of that — the same choice
  // `packages/db/test/invariants/sensitive.spec.ts` and `credentials.spec.ts`
  // make for source files that do not exist as an importable API. The
  // trade-off is the same one those files accept too: an explanatory doc
  // comment that quotes the PRD's own bad example would also be flagged.)
  it("Task 1's assemble.ts carries no institutional voice in its literal strings, once it lands", () => {
    const path = join(repoRoot(), "packages/core/src/documents/assemble.ts");
    const source = readIfExists(path);
    if (source === null) {
      expect(source).toBeNull(); // pending: Task 1 has not landed in this branch yet
      return;
    }
    expect(institutionalVoiceHits(source)).toEqual([]);
  });
});

describe("INV-003 · Task 2's seeded contestation prompt, once it lands", () => {
  // Task 2 (packages/ai/src/contest.ts plus a versioned prompt row, seeded
  // the way `EXTRACT_PROMPT_V1` is) may not exist in this branch yet — it is
  // being built in parallel and its filename is not this task's to name.
  // Scanning every file already in `packages/ai/src/prompts/` — real
  // content today (`extract.v1.ts`) — means this goes live automatically
  // the moment a contestation prompt lands beside it, with no edit here.
  const promptsDir = join(repoRoot(), "packages/ai/src/prompts");
  const promptFiles = readdirSync(promptsDir).filter((file) => file.endsWith(".ts"));

  it("actually scanned real prompt files, not an empty directory", () => {
    expect(promptFiles).toEqual(expect.arrayContaining(["extract.v1.ts"]));
  });

  it("finds no institutional voice in any seeded prompt body", () => {
    const offenders: Array<{ file: string; term: string }> = [];
    for (const file of promptFiles) {
      const text = readFileSync(join(promptsDir, file), "utf8");
      for (const term of institutionalVoiceHits(text)) offenders.push({ file, term });
    }
    expect(offenders).toEqual([]);
  });
});
