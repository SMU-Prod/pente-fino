import { describe, expect, it } from "vitest";
import { buildDossier, type BuildDossierInput } from "./dossier.js";
import { assembleContest } from "./assemble.js";
import type { ContestDocument } from "./contest.js";
import type { Playbook, Stage } from "../cases/playbook.js";

// A real, mod-11-valid CNPJ — the same fixture `mask.test.ts` uses for
// "Claro Móvel" — so the CNPJ-survives-unmasked test is meaningful: if this
// value were accidentally routed through `maskText`, it would in fact be
// replaced (unlike a random 14-digit string, which `maskText` would leave
// alone because its check digits fail).
const VALID_CNPJ = "40432544000147";

// The brief's own example: a digit-for-digit valid CPF. Used both as "PII
// that must be masked" (in prose fields) and, deliberately, as a protocol
// number (a field that must survive despite looking exactly like PII).
const VALID_CPF = "52998224725";

function contestDocument(overrides: Partial<ContestDocument> = {}): ContestDocument {
  return {
    subject: "Contestação de valores da fatura de junho",
    body: "x".repeat(250),
    requests: ["Estorno do valor contestado"],
    legalRefs: [{ law: "CDC", article: "art. 42" }],
    scriptForCall: ["Pedir o número de protocolo"],
    attachmentsChecklist: ["Fatura do período contestado"],
    ...overrides,
  };
}

type DocumentRow = BuildDossierInput["documents"][number];

function document(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "doc_1",
    stage: "sac",
    kind: "sac_script",
    createdAt: new Date("2026-06-10T12:00:00Z"),
    sentAt: null,
    userEdited: false,
    body: contestDocument(),
    editedBody: null,
    ...overrides,
  };
}

type ProtocolRow = BuildDossierInput["protocols"][number];

function protocol(overrides: Partial<ProtocolRow> = {}): ProtocolRow {
  return {
    id: "proto_1",
    stage: "sac",
    protocolNumber: "1234567",
    channel: "SAC da operadora",
    registeredAt: new Date("2026-06-05T12:00:00Z"),
    responseDueAt: new Date("2026-06-12T12:00:00Z"),
    responseReceivedAt: null,
    responseSummary: null,
    ...overrides,
  };
}

// `assemble.ts` is out of scope for this module (a sibling sub-task owns
// it) and its `BASE_ATTACHMENT` constant isn't exported — but `assembleContest`
// is, and returns it as `attachmentsChecklist[0]` whenever the stage doesn't
// require a previous protocol. This lets the F9 test below read the real,
// live value instead of hardcoding a second copy of it.
const ASSEMBLE_PLAYBOOK: Playbook = {
  stages: [
    {
      stage: "sac",
      channel: "SAC da operadora",
      responseDays: 7,
      businessDays: false,
      requiresPreviousProtocol: false,
      asks: [],
      legalRefs: [],
    },
  ],
};

function baseInput(overrides: Partial<BuildDossierInput> = {}): BuildDossierInput {
  return {
    case: {
      id: "case_1",
      stage: "jec_ready" as Stage,
      createdAt: new Date("2026-01-05T10:00:00Z"),
      stageEnteredAt: new Date("2026-06-01T10:00:00Z"),
      outcome: null,
      closedAt: null,
    },
    issuer: { displayName: "Operadora Exemplo S.A.", cnpj: VALID_CNPJ, category: "telecom" },
    invoice: {
      id: "invoice_1",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      dueDate: "2026-07-10",
      totalCents: 15000,
      createdAt: new Date("2026-01-01T09:00:00Z"),
      fileKey: "invoices/invoice_1.pdf",
    },
    contested: [],
    documents: [],
    protocols: [],
    events: [],
    generatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("buildDossier · timeline ordering", () => {
  it("orders entries ascending by `at` across case, invoice, documents, protocols and events", () => {
    const input = baseInput({
      documents: [document({ id: "doc_1", createdAt: new Date("2026-06-10T12:00:00Z") })],
      protocols: [protocol({ id: "proto_1", registeredAt: new Date("2026-06-05T12:00:00Z") })],
      events: [
        { id: "evt_1", type: "deadline_expired", occurredAt: new Date("2026-06-20T12:00:00Z"), payload: {} },
      ],
    });

    const dossier = buildDossier(input);
    const timestamps = dossier.entries.map((entry) => entry.at.getTime());
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);

    const kinds = dossier.entries.map((entry) => entry.kind);
    expect(kinds).toContain("document");
    expect(kinds).toContain("protocol");
    expect(kinds).toContain("deadline");
  });

  it("breaks same-instant ties the same way regardless of input array order", () => {
    // Object-literal property order (`{ documents, protocols }` vs
    // `{ protocols, documents }`) is NOT input array order — `buildDossier`
    // reads `input.documents` and `input.protocols` by name regardless of
    // where they sit in the literal, so swapping those two properties
    // proves nothing. The real risk is *within* one array: two same-instant
    // rows passed as `[a, b]` vs `[b, a]`. Deleting `.sort(compareEntries)`
    // from `buildDossier` makes this test fail (the entries would then come
    // out in whatever order `documents` was iterated in, which flips
    // between the two calls below).
    const tie = new Date("2026-06-10T12:00:00Z");
    const docA = document({ id: "doc_a", createdAt: tie });
    const docB = document({ id: "doc_b", createdAt: tie });

    const forward = buildDossier(baseInput({ documents: [docA, docB] }))
      .entries.map((e) => e.sourceId);
    const reversed = buildDossier(baseInput({ documents: [docB, docA] }))
      .entries.map((e) => e.sourceId);

    expect(forward).toEqual(reversed);
  });

  it("falls back to a title comparison when kind and sourceId also tie", () => {
    // A document sent at the exact same instant it was generated: both
    // entries share `kind: "document"` and the same `sourceId`, so only the
    // title text ("Documento gerado…" vs "Documento enviado…") is left to
    // break the tie deterministically.
    const tie = new Date("2026-06-10T12:00:00Z");
    const dossier = buildDossier(baseInput({ documents: [document({ createdAt: tie, sentAt: tie })] }));
    const documentEntries = dossier.entries.filter((e) => e.kind === "document");
    expect(documentEntries.map((e) => e.title)).toEqual(
      [...documentEntries.map((e) => e.title)].sort(),
    );
  });

  it("breaks same-instant ties across different kinds by the fixed KIND_ORDER, not by discovery order", () => {
    // Four different-kind entries, all landing on the exact same instant —
    // the case's own row, the invoice, a document and a protocol. Nothing
    // in `buildDossier` controls the order these four sources are iterated
    // in other than `KIND_ORDER` itself, so this pins down that the choice
    // of order (not just its existence) is real behaviour. Reversing
    // `KIND_ORDER` in the source flips this list end to end.
    const tie = new Date("2026-01-01T00:00:00Z");
    const input = baseInput({
      case: { ...baseInput().case, createdAt: tie },
      invoice: { ...baseInput().invoice, createdAt: tie },
      documents: [document({ createdAt: tie })],
      protocols: [protocol({ registeredAt: tie })],
    });
    const dossier = buildDossier(input);
    const kindsAtTie = dossier.entries
      .filter((e) => e.at.getTime() === tie.getTime())
      .map((e) => e.kind);
    expect(kindsAtTie).toEqual(["case_opened", "invoice", "document", "protocol"]);
  });
});

describe("buildDossier · masking (INV-007)", () => {
  it("keeps a valid-CPF-shaped protocol number unmasked everywhere it appears", () => {
    const input = baseInput({
      protocols: [
        protocol({
          id: "proto_1",
          protocolNumber: VALID_CPF,
          responseReceivedAt: new Date("2026-06-08T12:00:00Z"),
          responseSummary: "Atendimento concluído sem retorno concreto",
        }),
      ],
    });

    const dossier = buildDossier(input);

    const registered = dossier.entries.find((e) => e.kind === "protocol");
    expect(registered?.details.join(" ")).toContain(VALID_CPF);

    const response = dossier.entries.find((e) => e.kind === "protocol_response");
    expect(response?.details.join(" ")).toContain(VALID_CPF);

    const attachment = dossier.attachments.find((a) => a.label.includes(VALID_CPF));
    expect(attachment).toBeDefined();
    expect(attachment?.status).toBe("user_provided");
  });

  it("masks a CPF planted in a contested description and in a document subject", () => {
    const description = `Cobranca duplicada associada ao CPF ${VALID_CPF} do titular`;
    const subject = `Contestacao referente ao CPF ${VALID_CPF}`;
    const input = baseInput({
      contested: [{ itemId: "item_1", description, amountCents: 5000, evidence: [] }],
      documents: [document({ body: contestDocument({ subject }) })],
    });

    const dossier = buildDossier(input);

    expect(dossier.contestedItems[0]?.description).toContain("[CPF]");
    expect(dossier.contestedItems[0]?.description).not.toContain(VALID_CPF);

    const generated = dossier.entries.find((e) => e.title === "Documento gerado — SAC · Roteiro de atendimento (SAC)");
    expect(generated?.details.join(" ")).toContain("[CPF]");
    expect(generated?.details.join(" ")).not.toContain(VALID_CPF);
  });

  it("masks evidence strings on a contested item", () => {
    const input = baseInput({
      contested: [{
        itemId: "item_1",
        description: "Item duplicado",
        amountCents: 3000,
        evidence: [`Comprovante emitido para o CPF ${VALID_CPF}`],
      }],
    });

    const dossier = buildDossier(input);
    expect(dossier.contestedItems[0]?.evidence[0]).toContain("[CPF]");
  });

  it("says the response summary is missing when a response was received without one", () => {
    const input = baseInput({
      protocols: [protocol({
        responseReceivedAt: new Date("2026-06-08T12:00:00Z"),
        responseSummary: null,
      })],
    });
    const dossier = buildDossier(input);
    const response = dossier.entries.find((e) => e.kind === "protocol_response");
    expect(response?.details).toContain("Resumo não informado");
  });

  it("masks a protocol's responseSummary but never its channel", () => {
    const input = baseInput({
      protocols: [protocol({
        channel: "consumidor.gov.br",
        responseReceivedAt: new Date("2026-06-08T12:00:00Z"),
        responseSummary: `Resposta enviada ao CPF ${VALID_CPF}`,
      })],
    });

    const dossier = buildDossier(input);
    const response = dossier.entries.find((e) => e.kind === "protocol_response");
    expect(response?.details.join(" ")).toContain("[CPF]");
    expect(response?.title).toContain("consumidor.gov.br");
  });

  it("keeps the issuer CNPJ unmasked in the empresa party", () => {
    const dossier = buildDossier(baseInput());
    const empresa = dossier.parties.find((p) => p.role === "empresa");
    expect(empresa?.document).toBe(VALID_CNPJ);
    expect(empresa?.name).toBe("Operadora Exemplo S.A.");
  });

  it("falls back to a placeholder when a contested item has no description", () => {
    const input = baseInput({
      contested: [{ itemId: null, description: null, amountCents: 1200, evidence: [] }],
    });
    const dossier = buildDossier(input);
    expect(dossier.contestedItems[0]?.description).toBeTruthy();
  });
});

describe("buildDossier · parties (no PII the system does not hold)", () => {
  it("never invents consumidor data and lists the exact fields the person must fill by hand", () => {
    const dossier = buildDossier(baseInput());
    const consumidor = dossier.parties.find((p) => p.role === "consumidor");
    expect(consumidor?.name).toBeNull();
    expect(consumidor?.document).toBeNull();
    // Exact content, not just "some fields exist" — replacing the five
    // labels with a single placeholder must fail this test.
    expect(consumidor?.fields).toEqual([
      "Nome completo", "CPF", "Endereço completo", "Telefone", "E-mail",
    ]);
    // `BuildDossierInput` has no field carrying the user's email anywhere
    // (`users` isn't part of this input at all) — the type itself is what
    // guarantees the dossier can't contain it, not a runtime scan of the
    // notes text, so there is nothing meaningful left to assert here.
    expect(dossier.notes).toContain(
      "Os dados do(a) consumidor(a) (nome completo, CPF, endereço e telefone) não são " +
      "mantidos pelo sistema e precisam ser preenchidos manualmente antes de protocolar " +
      "no Juizado Especial Cível.",
    );
  });
});

describe("buildDossier · RF-110 invoice file expiry", () => {
  it("marks the invoice attachment expired and adds a notes line when fileKey is null", () => {
    const expiredAt = new Date("2026-07-15T00:00:00Z");
    const input = baseInput({
      invoice: { ...baseInput().invoice, fileKey: null },
      events: [{ id: "evt_1", type: "invoice_file_expired", occurredAt: expiredAt, payload: {} }],
    });

    const dossier = buildDossier(input);

    expect(dossier.invoice.fileAvailable).toBe(false);
    expect(dossier.invoice.fileExpiredAt).toEqual(expiredAt);

    const attachment = dossier.attachments.find((a) => a.label === "Fatura do período contestado");
    expect(attachment?.status).toBe("expired");
    expect(attachment?.note).toBeDefined();

    expect(dossier.notes.some((n) => n.toLowerCase().includes("armazenamento"))).toBe(true);
  });

  it("marks the invoice attachment available when fileKey is present", () => {
    const dossier = buildDossier(baseInput());
    expect(dossier.invoice.fileAvailable).toBe(true);
    expect(dossier.invoice.fileExpiredAt).toBeNull();
    const attachment = dossier.attachments.find((a) => a.label === "Fatura do período contestado");
    expect(attachment?.status).toBe("available");
    expect(attachment?.note).toBeUndefined();
  });

  it("never claims the invoice file is gone when fileKey is present", () => {
    // The dossier must not pretend the invoice is unavailable when it is
    // in fact still held — a false "arquivo não está mais disponível" line
    // would mislead the reader about their own case's evidence.
    const dossier = buildDossier(baseInput());
    const notesText = dossier.notes.join(" ").toLowerCase();
    expect(notesText).not.toContain("não está mais disponível");
    expect(notesText).not.toContain("removid");
  });

  it("uses the latest invoice_file_expired event when more than one is present", () => {
    const earlier = new Date("2026-07-01T00:00:00Z");
    const later = new Date("2026-07-20T00:00:00Z");
    const input = baseInput({
      invoice: { ...baseInput().invoice, fileKey: null },
      events: [
        { id: "evt_1", type: "invoice_file_expired", occurredAt: earlier, payload: {} },
        { id: "evt_2", type: "invoice_file_expired", occurredAt: later, payload: {} },
      ],
    });
    const dossier = buildDossier(input);
    expect(dossier.invoice.fileExpiredAt).toEqual(later);
  });

  it("still marks the invoice expired with a generic note when no invoice_file_expired event is present", () => {
    const input = baseInput({ invoice: { ...baseInput().invoice, fileKey: null } });
    const dossier = buildDossier(input);
    expect(dossier.invoice.fileAvailable).toBe(false);
    expect(dossier.invoice.fileExpiredAt).toBeNull();
    const attachment = dossier.attachments.find((a) => a.label === "Fatura do período contestado");
    expect(attachment?.note).toBeDefined();
  });
});

describe("buildDossier · attachments", () => {
  it("de-duplicates the checklist across documents, case-insensitively after trimming", () => {
    const docA = document({
      id: "doc_a",
      body: contestDocument({ attachmentsChecklist: ["Fatura do período contestado", "Comprovante de pagamento"] }),
    });
    const docB = document({
      id: "doc_b",
      stage: "ombudsman",
      createdAt: new Date("2026-06-11T12:00:00Z"),
      body: contestDocument({ attachmentsChecklist: ["  COMPROVANTE DE PAGAMENTO  ", "Print da conversa"] }),
    });

    const dossier = buildDossier(baseInput({ documents: [docA, docB] }));
    const labels = dossier.attachments.map((a) => a.label.toLowerCase());

    expect(labels.filter((l) => l === "comprovante de pagamento")).toHaveLength(1);
    expect(labels).toContain("print da conversa");
    // Entry 1 (the invoice itself) already covers this label; the checklist
    // copy must be skipped rather than listed twice.
    expect(labels.filter((l) => l === "fatura do período contestado")).toHaveLength(1);
  });

  it("adds one user_provided attachment per protocol, with the number unmasked", () => {
    const dossier = buildDossier(baseInput({
      protocols: [protocol({ protocolNumber: "9988776", channel: "Procon" })],
    }));
    const proof = dossier.attachments.find((a) => a.label.includes("9988776"));
    expect(proof?.status).toBe("user_provided");
    expect(proof?.label).toContain("Procon");
  });

  it("masks a CPF planted in a checklist entry (INV-007, on model-written prose)", () => {
    const input = baseInput({
      documents: [document({
        body: contestDocument({
          attachmentsChecklist: [`Comprovante em nome do titular CPF ${VALID_CPF}`],
        }),
      })],
    });
    const dossier = buildDossier(input);
    const entry = dossier.attachments.find((a) => a.status === "user_provided" && a.label.includes("[CPF]"));
    expect(entry).toBeDefined();
    expect(dossier.attachments.some((a) => a.label.includes(VALID_CPF))).toBe(false);
  });

  it("uses the edited checklist over the original when the document was edited (RF-164)", () => {
    const input = baseInput({
      documents: [document({
        body: contestDocument({ attachmentsChecklist: ["Fatura do período contestado", "Checklist original"] }),
        editedBody: contestDocument({ attachmentsChecklist: ["Fatura do período contestado", "Checklist editado"] }),
        userEdited: true,
      })],
    });
    const dossier = buildDossier(input);
    const labels = dossier.attachments.map((a) => a.label);
    expect(labels).toContain("Checklist editado");
    expect(labels).not.toContain("Checklist original");
  });
});

describe("buildDossier · event de-duplication against already-rendered rows", () => {
  it("does not duplicate a contest_generated event that names an existing document", () => {
    const doc = document({ id: "doc_1" });
    const input = baseInput({
      documents: [doc],
      events: [{ id: "evt_1", type: "contest_generated", occurredAt: doc.createdAt, payload: { documentId: doc.id } }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeUndefined();
  });

  it("keeps a contest_generated event whose payload names no document", () => {
    const input = baseInput({
      events: [{ id: "evt_1", type: "contest_generated", occurredAt: new Date("2026-06-10T12:00:00Z"), payload: {} }],
    });
    const dossier = buildDossier(input);
    const kept = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(kept).toBeDefined();
    expect(kept?.kind).toBe("document");
  });

  it("matches a contest_edited event via the alternate docId payload key", () => {
    const doc = document({ id: "doc_1" });
    const input = baseInput({
      documents: [doc],
      events: [{ id: "evt_1", type: "contest_edited", occurredAt: doc.createdAt, payload: { docId: doc.id } }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeUndefined();
  });

  it("does not duplicate contest_marked_sent when it names an existing document", () => {
    const doc = document({ id: "doc_1", sentAt: new Date("2026-06-11T12:00:00Z") });
    const input = baseInput({
      documents: [doc],
      events: [{ id: "evt_1", type: "contest_marked_sent", occurredAt: doc.sentAt!, payload: { documentId: doc.id } }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeUndefined();
  });

  it("matches protocol_entered via protocolId", () => {
    const proto = protocol({ id: "proto_1" });
    const input = baseInput({
      protocols: [proto],
      events: [{ id: "evt_1", type: "protocol_entered", occurredAt: proto.registeredAt, payload: { protocolId: proto.id } }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeUndefined();
  });

  it("matches protocol_entered via protocolNumber when protocolId is absent", () => {
    const proto = protocol({ id: "proto_1", protocolNumber: "555444" });
    const input = baseInput({
      protocols: [proto],
      events: [{ id: "evt_1", type: "protocol_entered", occurredAt: proto.registeredAt, payload: { protocolNumber: "555444" } }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeUndefined();
  });

  it("keeps a protocol_entered event that names no known protocol", () => {
    const input = baseInput({
      events: [{ id: "evt_1", type: "protocol_entered", occurredAt: new Date("2026-06-05T12:00:00Z"), payload: { protocolId: "unknown" } }],
    });
    const dossier = buildDossier(input);
    const kept = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(kept).toBeDefined();
    expect(kept?.kind).toBe("protocol");
  });

  it("drops a case_created event with no payload at all", () => {
    const input = baseInput({
      events: [{ id: "evt_1", type: "case_created", occurredAt: new Date("2026-01-05T10:00:00Z"), payload: {} }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeUndefined();
  });

  it("drops a case_created event whose payload.caseId matches this case", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "case_created", occurredAt: new Date("2026-01-05T10:00:00Z"),
        payload: { caseId: "case_1" },
      }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeUndefined();
  });

  it("keeps a case_created event whose payload names a different case", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "case_created", occurredAt: new Date("2026-01-05T10:00:00Z"),
        payload: { caseId: "some_other_case" },
      }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")).toBeDefined();
  });
});

describe("buildDossier · event kinds and labels", () => {
  it.each([
    ["stage_advanced", "stage_change"],
    ["deadline_expired", "deadline"],
    ["invoice_file_expired", "invoice"],
    ["outcome_confirmed", "outcome"],
    ["case_reopened", "stage_change"],
    ["diff_run", "other"],
    ["invoice_file_expiry_failed", "other"],
    ["dossier_generated", "other"],
    ["dossier_generation_failed", "other"],
  ] as const)("maps event type %s to kind %s", (type, kind) => {
    const input = baseInput({
      events: [{ id: "evt_1", type, occurredAt: new Date("2026-06-15T00:00:00Z"), payload: {} }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.kind).toBe(kind);
    expect(entry?.title.length).toBeGreaterThan(0);
  });

  it("gives dossier_generated and dossier_generation_failed their own pt-BR labels, not the raw-type fallback", () => {
    // RF-187's own job (Task 7, sibling sub-task, in flight in this
    // worktree) writes these two event types on every dossier run. Without
    // an `EVENT_META` entry, a regeneration's `dossier_generated` row would
    // fall through to `Evento do caso: dossier_generated`.
    const input = baseInput({
      events: [
        { id: "evt_1", type: "dossier_generated", occurredAt: new Date("2026-06-15T00:00:00Z"), payload: {} },
        { id: "evt_2", type: "dossier_generation_failed", occurredAt: new Date("2026-06-16T00:00:00Z"), payload: {} },
      ],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")?.title).toBe("Dossiê gerado");
    expect(dossier.entries.find((e) => e.sourceId === "evt_2")?.title).toBe("Falha ao gerar o dossiê");
  });

  it("gives an unrecognised event type kind 'other' and a safe fallback title", () => {
    const input = baseInput({
      events: [{ id: "evt_1", type: "some_future_event_type", occurredAt: new Date("2026-06-15T00:00:00Z"), payload: {} }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.kind).toBe("other");
    expect(entry?.title).toContain("some_future_event_type");
  });
});

describe("buildDossier · documents", () => {
  it("uses editedBody over body for the rendered subject (RF-164)", () => {
    const input = baseInput({
      documents: [document({
        body: contestDocument({ subject: "Assunto original" }),
        editedBody: contestDocument({ subject: "Assunto editado pelo usuário" }),
        userEdited: true,
      })],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.kind === "document");
    expect(entry?.details.join(" ")).toContain("Assunto editado pelo usuário");
    expect(entry?.details.join(" ")).not.toContain("Assunto original");
    expect(entry?.details.join(" ")).toContain("Editado pelo usuário");
  });

  it("adds a second entry at sentAt when the document was sent", () => {
    const input = baseInput({
      documents: [document({ sentAt: new Date("2026-06-12T09:00:00Z") })],
    });
    const dossier = buildDossier(input);
    const documentEntries = dossier.entries.filter((e) => e.kind === "document");
    expect(documentEntries).toHaveLength(2);
    expect(documentEntries.some((e) => e.title.startsWith("Documento enviado"))).toBe(true);
  });

  it("falls back to a generic label for an unrecognised document kind", () => {
    const input = baseInput({ documents: [document({ kind: "future_kind" })] });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.kind === "document");
    expect(entry?.title).toContain("future_kind");
  });
});

describe("buildDossier · case lifecycle entries", () => {
  it("adds an outcome entry with a pt-BR label when the case is closed with a known outcome", () => {
    const input = baseInput({
      case: { ...baseInput().case, outcome: "resolved", closedAt: new Date("2026-08-05T00:00:00Z") },
    });
    const dossier = buildDossier(input);
    const outcome = dossier.entries.find((e) => e.kind === "outcome");
    expect(outcome?.title).toContain("Resolvido");
  });

  it("adds an outcome entry even when the case closed without a recorded outcome", () => {
    const input = baseInput({
      case: { ...baseInput().case, outcome: null, closedAt: new Date("2026-08-05T00:00:00Z") },
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.kind === "outcome")).toBeDefined();
  });

  it("uses a fallback label for an outcome value outside the known set", () => {
    const input = baseInput({
      case: { ...baseInput().case, outcome: "future_outcome", closedAt: new Date("2026-08-05T00:00:00Z") },
    });
    const dossier = buildDossier(input);
    const outcome = dossier.entries.find((e) => e.kind === "outcome");
    expect(outcome?.title).toContain("future_outcome");
  });

  it("adds no outcome entry for an open case", () => {
    const dossier = buildDossier(baseInput());
    expect(dossier.entries.find((e) => e.kind === "outcome")).toBeUndefined();
  });
});

describe("buildDossier · invoice fields with missing data", () => {
  it("renders 'não informado' for null period, due date and total", () => {
    const input = baseInput({
      invoice: {
        ...baseInput().invoice,
        periodStart: null,
        periodEnd: null,
        dueDate: null,
        totalCents: null,
      },
    });
    const dossier = buildDossier(input);
    expect(dossier.invoice.periodStart).toBeNull();
    expect(dossier.invoice.totalCents).toBeNull();
    const entry = dossier.entries.find((e) => e.kind === "invoice");
    expect(entry?.details.join(" ")).toContain("não informado");
  });

  it("falls back to the raw string instead of emitting 'undefined' for a malformed ISO date", () => {
    // `noUncheckedIndexedAccess` types the destructured [year, month, day]
    // as `string | undefined` — a value with a missing segment must not
    // silently render "undefined/06/2026".
    const input = baseInput({
      invoice: { ...baseInput().invoice, periodStart: "2026-06" },
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.kind === "invoice");
    const text = entry?.details.join(" ") ?? "";
    expect(text).not.toContain("undefined");
    expect(text).toContain("2026-06");
  });
});

describe("buildDossier · empty case", () => {
  it("still produces the invoice entry and invoice attachment with no documents, protocols or extra events", () => {
    const dossier = buildDossier(baseInput());
    expect(dossier.entries.some((e) => e.kind === "invoice")).toBe(true);
    expect(dossier.attachments.some((a) => a.label === "Fatura do período contestado")).toBe(true);
    expect(dossier.caseId).toBe("case_1");
    expect(dossier.invoiceId).toBe("invoice_1");
  });
});

describe("buildDossier · contestedTotalCents", () => {
  it("sums the amounts of every contested item", () => {
    const input = baseInput({
      contested: [
        { itemId: "i1", description: "Item 1", amountCents: 1000, evidence: [] },
        { itemId: "i2", description: "Item 2", amountCents: 2500, evidence: [] },
      ],
    });
    const dossier = buildDossier(input);
    expect(dossier.contestedTotalCents).toBe(3500);
  });

  it("is zero when there are no contested items", () => {
    const dossier = buildDossier(baseInput());
    expect(dossier.contestedTotalCents).toBe(0);
  });
});

describe("buildDossier · display formatting (dates and money actually shown to a person)", () => {
  it("renders known ISO dates as dd/MM/yyyy and a known amount in reais", () => {
    const input = baseInput({
      invoice: {
        ...baseInput().invoice,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        dueDate: "2026-07-10",
        totalCents: 15000,
      },
      protocols: [protocol({
        registeredAt: new Date("2026-06-05T12:00:00Z"),
        responseDueAt: new Date("2026-06-12T12:00:00Z"),
      })],
    });
    const dossier = buildDossier(input);

    const invoiceText = dossier.entries.find((e) => e.kind === "invoice")?.details.join(" ") ?? "";
    expect(invoiceText).toContain("01/06/2026");
    expect(invoiceText).toContain("30/06/2026");
    expect(invoiceText).toContain("10/07/2026");
    expect(invoiceText).toContain("R$ 150,00");

    const protocolText = dossier.entries.find((e) => e.kind === "protocol")?.details.join(" ") ?? "";
    expect(protocolText).toContain("12/06/2026");
  });
});

describe("buildDossier · sourceId provenance (principle A3)", () => {
  it("stamps each entry's sourceId with the id of the row it actually came from", () => {
    const input = baseInput({
      documents: [document({ id: "doc_x" })],
      protocols: [protocol({ id: "proto_x" })],
    });
    const dossier = buildDossier(input);

    expect(dossier.entries.find((e) => e.kind === "invoice")?.sourceId).toBe("invoice_1");
    expect(dossier.entries.find((e) => e.kind === "document")?.sourceId).toBe("doc_x");
    expect(dossier.entries.find((e) => e.kind === "protocol")?.sourceId).toBe("proto_x");
  });
});

describe("buildDossier · invoice attachment label stays in sync with the contest letter (assemble.ts)", () => {
  it("uses the exact same base attachment label assemble.ts tells the person to bring", () => {
    // Reads the real, live value through the public `assembleContest`
    // function rather than a second hardcoded copy of `assemble.ts`'s
    // private `BASE_ATTACHMENT` — a hardcoded copy pins this module's own
    // label but cannot detect `assemble.ts`'s side drifting away from it,
    // which is exactly the direction this test exists to catch (drift would
    // otherwise list the invoice twice under two different labels with
    // nothing failing).
    const assembled = assembleContest({ findings: [], stage: "sac", playbook: ASSEMBLE_PLAYBOOK });
    const dossier = buildDossier(baseInput());
    const invoiceAttachment = dossier.attachments.find(
      (a) => a.status === "available" || a.status === "expired",
    );
    expect(invoiceAttachment?.label).toBe(assembled.attachmentsChecklist[0]);
  });
});

describe("buildDossier · event payload enrichment (allow-listed details)", () => {
  it("renders a stage transition as two lines — which stage it left and which it entered", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "stage_advanced", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { fromStage: "sac", toStage: "ombudsman" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Etapa anterior: SAC", "Nova etapa: Ouvidoria"]);
  });

  it("renders an alias pair (previousStage/newStage) the same way as fromStage/toStage", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "stage_advanced", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { previousStage: "procon", newStage: "jec_ready" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual([
      "Etapa anterior: Procon", "Nova etapa: Pronto para o Juizado Especial Cível",
    ]);
  });

  it("renders a stage value that isn't a known Stage verbatim, without crashing", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "stage_advanced", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { newStage: "etapa_futura" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Nova etapa: etapa_futura"]);
  });

  it("renders the bare 'stage' alias (no from/to pairing) under its own neutral label", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "case_reopened", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { stage: "procon" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Etapa: Procon"]);
  });

  it("renders a non-string stage-ish value verbatim, without attempting a STAGE_LABELS lookup", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "case_reopened", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { stage: 7 },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Etapa: 7"]);
  });

  it("orders 'Etapa' before 'Nova etapa' when a payload carries both stage and toStage", () => {
    // A payload with the bare `stage` alongside the directed `toStage`
    // describes one transition, not two independent facts — "Etapa: SAC"
    // (where things stand) has to read before "Nova etapa: Procon" (where
    // they're going), not after it.
    const input = baseInput({
      events: [{
        id: "evt_1", type: "stage_advanced", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { stage: "sac", toStage: "procon" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Etapa: SAC", "Nova etapa: Procon"]);
  });

  it("routes an allow-listed outcome value through OUTCOME_LABELS when it's a known member", () => {
    // `cases.outcome` (RF-186) and an event payload's `outcome` field carry
    // the identical enum — `resolved | partial | denied | abandoned` — so a
    // recognised value here must get the same pt-BR translation this module
    // already gives `cases.outcome` elsewhere, not the raw English word.
    const input = baseInput({
      events: [{
        id: "evt_1", type: "outcome_confirmed", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { outcome: "resolved" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Desfecho: Resolvido integralmente"]);
  });

  it("renders an outcome value outside OUTCOME_LABELS verbatim, without inventing a translation", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "outcome_confirmed", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { outcome: "future_outcome_value" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Desfecho: future_outcome_value"]);
  });

  it("does not treat a bare number under a date-ish key as an epoch timestamp", () => {
    // `{ at: 5 }` must not become `01/01/1970` — a plausible-looking but
    // silently wrong date on a document going to a Juizado. Only strings
    // are accepted under `kind: "date"`; a bare number falls through to the
    // verbatim fallback instead.
    const input = baseInput({
      events: [{
        id: "evt_1", type: "deadline_expired", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { at: 5 },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Data: 5"]);
    expect(entry?.details?.join(" ")).not.toContain("1970");
  });

  it("formats a date-ish payload value and leaves protocolNumber unmasked while masking reason", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "deadline_expired", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: {
          deadlineAt: "2026-06-20T00:00:00.000Z",
          protocolNumber: VALID_CPF,
          reason: `Prazo vencido para o titular do CPF ${VALID_CPF}`,
        },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toContain("Data: 20/06/2026");
    expect(entry?.details).toContain(`Número do protocolo: ${VALID_CPF}`);
    const reasonLine = entry?.details.find((d) => d.startsWith("Motivo:"));
    expect(reasonLine).toContain("[CPF]");
    expect(reasonLine).not.toContain(VALID_CPF);
  });

  it("masks a date-ish value that doesn't parse as a date, instead of rendering it raw", () => {
    // The previous version of this test used "not-a-date", a string with
    // nothing maskable in it — it passed even if the masking step were
    // skipped entirely on this branch. Planting a CPF in the unparseable
    // value makes the "(masked)" half of the behaviour actually load-bearing.
    const input = baseInput({
      events: [{
        id: "evt_1", type: "deadline_expired", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { at: `Sem data definida, CPF ${VALID_CPF}` },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Data: Sem data definida, CPF [CPF]"]);
  });

  it("accepts boolean and number primitive values under an allow-listed key", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "diff_run", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { reason: true, outcome: 42 },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Motivo: true", "Desfecho: 42"]);
  });

  it("never renders a key that is not on the allow-list, and never leaks the raw key name", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "diff_run", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { someInternalFieldName: "should never appear", reason: "Motivo legítimo" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Motivo: Motivo legítimo"]);
    expect(entry?.details.join(" ")).not.toContain("someInternalFieldName");
  });

  it("ignores a non-primitive value even under an allow-listed key", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "diff_run", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { reason: { nested: true }, channel: "SAC" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Canal: SAC"]);
  });

  it("orders rendered lines by the allow-list's own order, not by the payload's own key order", () => {
    const input = baseInput({
      events: [{
        id: "evt_1", type: "outcome_confirmed", occurredAt: new Date("2026-06-15T00:00:00Z"),
        // Deliberately inserted in reverse of the allow-list's order.
        payload: { outcome: "resolved_like", reason: "Motivo", channel: "SAC" },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details).toEqual(["Canal: SAC", "Motivo: Motivo", "Desfecho: resolved_like"]);
  });

  it("caps a very long rendered detail line at a sane length", () => {
    const longReason = "x".repeat(500);
    const input = baseInput({
      events: [{
        id: "evt_1", type: "diff_run", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { reason: longReason },
      }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.details[0]?.length).toBeLessThan(210);
  });

  it("renders no details for a payload that has keys, but none of them on the allow-list", () => {
    // An empty `{}` payload can't distinguish "correctly filtered everything
    // out" from "never renders anything" — a payload that actually has keys,
    // just none recognised, is the case worth pinning down.
    const input = baseInput({
      events: [{
        id: "evt_1", type: "diff_run", occurredAt: new Date("2026-06-15T00:00:00Z"),
        payload: { irrelevantKey: "x", anotherIrrelevantKey: 123 },
      }],
    });
    const dossier = buildDossier(input);
    expect(dossier.entries.find((e) => e.sourceId === "evt_1")?.details).toEqual([]);
  });
});

describe("buildDossier · document requests reach the dossier (RF-187 completeness)", () => {
  it("adds each request as a masked details line beneath the subject", () => {
    const requests = [`Estorno do valor referente ao CPF ${VALID_CPF}`, "Correção da fatura"];
    const input = baseInput({
      documents: [document({ body: contestDocument({ subject: "Assunto X", requests }) })],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.title.startsWith("Documento gerado"));
    const details = entry?.details ?? [];

    expect(details[0]).toBe("Assunto: Assunto X");
    expect(details).toContain("Pedido: Correção da fatura");
    const cpfLine = details.find((d) => d.startsWith("Pedido:") && d.includes("[CPF]"));
    expect(cpfLine).toBeDefined();
    expect(details.some((d) => d.includes(VALID_CPF))).toBe(false);
  });

  it("uses editedBody's requests over body's when the document was edited (RF-164)", () => {
    const input = baseInput({
      documents: [document({
        body: contestDocument({ requests: ["Pedido original"] }),
        editedBody: contestDocument({ requests: ["Pedido editado pelo usuário"] }),
        userEdited: true,
      })],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.kind === "document" && e.title.startsWith("Documento gerado"));
    expect(entry?.details.join(" ")).toContain("Pedido editado pelo usuário");
    expect(entry?.details.join(" ")).not.toContain("Pedido original");
  });

  it("also carries the request lines on the 'sent' entry", () => {
    const input = baseInput({
      documents: [document({
        body: contestDocument({ requests: ["Pedido a repetir"] }),
        sentAt: new Date("2026-06-12T09:00:00Z"),
      })],
    });
    const dossier = buildDossier(input);
    const sentEntry = dossier.entries.find((e) => e.title.startsWith("Documento enviado"));
    expect(sentEntry?.details).toContain("Pedido: Pedido a repetir");
  });
});
