import { describe, expect, it } from "vitest";
import { buildDossier, type BuildDossierInput } from "./dossier.js";
import type { ContestDocument } from "./contest.js";
import type { Stage } from "../cases/playbook.js";

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
    const tie = new Date("2026-06-10T12:00:00Z");
    const doc = document({ id: "doc_a", createdAt: tie });
    const proto = protocol({ id: "proto_a", registeredAt: tie });

    const a = buildDossier(baseInput({ documents: [doc], protocols: [proto] }))
      .entries.map((e) => `${e.kind}:${e.sourceId}`);
    const b = buildDossier(baseInput({ protocols: [proto], documents: [doc] }))
      .entries.map((e) => `${e.kind}:${e.sourceId}`);

    expect(a).toEqual(b);
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
  it("never invents consumidor data and lists the fields the person must fill by hand", () => {
    const dossier = buildDossier(baseInput());
    const consumidor = dossier.parties.find((p) => p.role === "consumidor");
    expect(consumidor?.name).toBeNull();
    expect(consumidor?.document).toBeNull();
    expect(consumidor?.fields.length).toBeGreaterThan(0);
    expect(dossier.notes.join(" ")).not.toContain("@");
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
  ] as const)("maps event type %s to kind %s", (type, kind) => {
    const input = baseInput({
      events: [{ id: "evt_1", type, occurredAt: new Date("2026-06-15T00:00:00Z"), payload: {} }],
    });
    const dossier = buildDossier(input);
    const entry = dossier.entries.find((e) => e.sourceId === "evt_1");
    expect(entry?.kind).toBe(kind);
    expect(entry?.title.length).toBeGreaterThan(0);
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
