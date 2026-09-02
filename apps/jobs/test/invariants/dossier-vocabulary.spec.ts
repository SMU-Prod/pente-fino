import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { lintUserFacingText } from "@pentefino/ai";
import { buildDossier } from "@pentefino/core";
import type { BuildDossierInput, ContestDocument } from "@pentefino/core";
import { renderDossierPdf } from "../../src/pdf/render-dossier.js";

/**
 * INV-004 (§14.3's forbidden vocabulary) and INV-005 (never promise a
 * result), applied to the one document in this product that a court reads.
 *
 * What this gates is *our* fixed pt-BR strings — every heading, label,
 * status word, attachment marker and note that `buildDossier` and
 * `renderDossierPdf` put on the page themselves. The fixture's
 * user-supplied text (a document's subject and requests, a protocol's
 * response summary, an item's description) is deliberately clean, so a
 * violation in this suite can only have come from a string this codebase
 * owns.
 *
 * It is emphatically NOT a runtime gate on what the person wrote. Text
 * someone typed into their own contestation is their words: the dossier
 * reproduces it as evidence of what was actually sent, and nothing here
 * rejects, rewrites or refuses to render it. §14.3 constrains what the
 * product says, not what the consumer says.
 */

// Fixed, short, ASCII ids: the renderer prints them in the title block and
// in every page footer, and a `newId` nanoid would put 21 random characters
// into the text this suite lints on every run.
const CASE_ID = "cas_vocab";
const INVOICE_ID = "inv_vocab";

async function extractRendered(input: BuildDossierInput): Promise<string> {
  const bytes = await renderDossierPdf(buildDossier(input));
  // pdfjs detaches the array it is handed; `bytes` is not needed afterwards
  // here, but the copy keeps that from being a latent trap for the next
  // person who adds an assertion about the bytes themselves.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

function contestDocument(overrides: Partial<ContestDocument> = {}): ContestDocument {
  return {
    subject: "Cancelamento de servicos adicionais e devolucao dos valores",
    body:
      "Prezados, na fatura do periodo constam servicos adicionais que nao foram solicitados. " +
      "Peco o cancelamento e a devolucao dos valores ja pagos, conforme o registro do atendimento.",
    requests: [
      "Cancelar os servicos adicionais nao solicitados",
      "Devolver os valores cobrados nos ultimos tres meses",
    ],
    legalRefs: [{ law: "CDC", article: "art. 42, paragrafo unico" }],
    scriptForCall: ["Informar o numero da linha e anotar o numero do protocolo"],
    attachmentsChecklist: ["Comprovante de pagamento da fatura", "Print da tela do aplicativo"],
    ...overrides,
  };
}

function input(overrides: Partial<BuildDossierInput> = {}): BuildDossierInput {
  return {
    case: {
      id: CASE_ID,
      stage: "jec_ready",
      createdAt: new Date("2026-04-12T08:00:00.000Z"),
      stageEnteredAt: new Date("2026-07-01T10:00:00.000Z"),
      outcome: null,
      closedAt: null,
    },
    issuer: { displayName: "Claro Móvel", cnpj: "40.432.544/0001-47", category: "telecom" },
    invoice: {
      id: INVOICE_ID,
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      dueDate: "2026-05-10",
      totalCents: 18990,
      createdAt: new Date("2026-04-10T09:00:00.000Z"),
      fileKey: "uploads/owner/hash.pdf",
    },
    contested: [
      {
        itemId: "itm_1",
        description: "Assinatura de aplicativo de video",
        amountCents: 2990,
        evidence: ["Linha na secao Aplicativos Digitais"],
      },
      { itemId: "itm_2", description: "Pacote de dados adicional", amountCents: 1990, evidence: [] },
    ],
    documents: [
      {
        id: "doc_1", stage: "sac", kind: "sac_script",
        createdAt: new Date("2026-04-13T10:00:00.000Z"),
        sentAt: new Date("2026-04-14T11:00:00.000Z"),
        userEdited: false, body: contestDocument(), editedBody: null,
      },
      {
        id: "doc_2", stage: "procon", kind: "contest_letter",
        createdAt: new Date("2026-06-01T09:00:00.000Z"),
        sentAt: null,
        userEdited: true,
        body: contestDocument(),
        editedBody: contestDocument({ subject: "Contestacao revisada pelo titular da linha" }),
      },
    ],
    protocols: [
      {
        id: "prt_1", stage: "sac", protocolNumber: "20260415-000987654", channel: "SAC telefonico",
        registeredAt: new Date("2026-04-15T09:00:00.000Z"),
        responseDueAt: new Date("2026-04-25T09:00:00.000Z"),
        responseReceivedAt: new Date("2026-05-02T14:00:00.000Z"),
        responseSummary: "A empresa registrou o pedido e pediu prazo para responder.",
      },
    ],
    events: [
      {
        id: "evt_1", type: "deadline_expired",
        occurredAt: new Date("2026-05-20T00:00:00.000Z"),
        payload: { stage: "sac", deadlineAt: "2026-05-20T00:00:00.000Z" },
      },
      {
        id: "evt_2", type: "stage_advanced",
        occurredAt: new Date("2026-07-01T10:00:00.000Z"),
        payload: { fromStage: "procon", toStage: "jec_ready" },
      },
    ],
    generatedAt: new Date("2026-08-31T12:00:00.000Z"),
    ...overrides,
  };
}

describe("INV-004/INV-005 · RF-187's dossier speaks §14.3's vocabulary", () => {
  it("says nothing forbidden on a case whose invoice file is still held", async () => {
    const text = await extractRendered(input());
    const result = lintUserFacingText(text);
    expect(result.violations.map((v) => v.term)).toStrictEqual([]);
    expect(result.ok).toBe(true);
  });

  it("says nothing forbidden on a closed case whose invoice file RF-110 already deleted", async () => {
    // The other half of the string surface: the expiry wording, the
    // "não está mais disponível no sistema" attachment status, the
    // retention note, and the outcome label — none of which the first
    // fixture ever renders.
    const text = await extractRendered(input({
      case: {
        id: CASE_ID, stage: "closed",
        createdAt: new Date("2026-04-12T08:00:00.000Z"),
        stageEnteredAt: new Date("2026-08-01T10:00:00.000Z"),
        outcome: "partial",
        closedAt: new Date("2026-08-10T10:00:00.000Z"),
      },
      invoice: { ...input().invoice, fileKey: null },
      events: [
        ...input().events,
        {
          id: "evt_3", type: "invoice_file_expired",
          occurredAt: new Date("2026-07-15T03:00:00.000Z"), payload: {},
        },
      ],
    }));

    const result = lintUserFacingText(text);
    expect(result.violations.map((v) => v.term)).toStrictEqual([]);
    expect(result.ok).toBe(true);
  });

  it("control: the linter this suite relies on actually fires", () => {
    // Without this, both assertions above would pass just as happily if
    // `lintUserFacingText` were broken and returned `ok` for everything.
    const result = lintUserFacingText("Nosso parecer juridico garante que voce vai receber em dobro");
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
