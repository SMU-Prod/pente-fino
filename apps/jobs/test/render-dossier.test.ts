import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { sniffMimeType } from "@pentefino/core";
import type { Dossier, DossierEntry } from "@pentefino/core";
import { renderDossierPdf } from "../src/pdf/render-dossier.js";

// Extraction inserts a line break wherever the layout wrapped text onto a
// new line, so a needle that spans a wrap point would never match a raw
// `.includes`. Collapsing every whitespace run (including newlines) to a
// single space, on both sides of the comparison, makes the assertion
// insensitive to exactly where the renderer happened to wrap — this is the
// one helper the brief asks for and it is used everywhere below.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function renderAndExtract(dossier: Dossier) {
  const bytes = await renderDossierPdf(dossier);
  // `getDocumentProxy` (pdfjs-dist underneath) takes ownership of the typed
  // array it is handed and detaches its buffer — a copy keeps `bytes`
  // usable afterwards (e.g. for `sniffMimeType`, exactly as sub-task C's
  // storage `put` will use it before this reader ever touches it).
  const pdf = await getDocumentProxy(bytes.slice());
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { bytes, text: normalizeWhitespace(text), totalPages };
}

function entry(overrides: Partial<DossierEntry> & Pick<DossierEntry, "at" | "title">): DossierEntry {
  return {
    kind: "other",
    details: [],
    sourceId: "src_1",
    ...overrides,
  };
}

function baseDossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    caseId: "cas_test123",
    invoiceId: "inv_test456",
    generatedAt: new Date("2026-08-15T10:00:00.000Z"),
    title: "Dossiê para o Juizado Especial Cível — Claro Móvel",
    parties: [
      {
        role: "consumidor",
        name: null,
        document: null,
        fields: ["Nome completo", "CPF", "Endereço completo", "Telefone", "E-mail"],
      },
      {
        role: "empresa",
        name: "Claro Móvel S.A.",
        document: "[CNPJ]",
        fields: [],
      },
    ],
    invoice: {
      issuerName: "Claro Móvel S.A.",
      category: "telecom",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      dueDate: "2026-07-10",
      totalCents: 15990,
      fileAvailable: false,
      fileExpiredAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    contestedItems: [
      {
        description: "Pacote de dados internacional não solicitado",
        amountCents: 4990,
        evidence: ["Protocolo [CPF] confirma ausência de solicitação"],
      },
      {
        description: "Assinatura de serviço de streaming duplicada",
        amountCents: 2999,
        evidence: [],
      },
    ],
    contestedTotalCents: 7989,
    entries: [
      entry({ at: new Date("2026-06-01T09:00:00.000Z"), kind: "case_opened", title: "Caso aberto", sourceId: "cas_test123" }),
      entry({
        at: new Date("2026-06-05T12:00:00.000Z"),
        kind: "invoice",
        title: "Fatura recebida",
        details: ["Período: 01/06/2026 a 30/06/2026", "Valor total: R$ 159,90"],
        sourceId: "inv_test456",
      }),
      entry({
        at: new Date("2026-06-10T15:30:00.000Z"),
        kind: "document",
        title: "Documento gerado — SAC · Roteiro de atendimento (SAC)",
        details: ["Assunto: contestação de cobrança indevida em ação de ç ã é í ó ú â ê ô à º —"],
        sourceId: "doc_1",
      }),
      entry({
        at: new Date("2026-06-20T08:00:00.000Z"),
        kind: "protocol",
        title: "Protocolo registrado — telefone",
        details: ["Número: [CPF]", "Etapa: SAC"],
        sourceId: "prot_1",
      }),
    ],
    attachments: [
      { label: "Fatura do período contestado", status: "expired", note: "Arquivo removido do armazenamento em 01/08/2026." },
      { label: "Comprovante do protocolo 12345 — telefone, 20/06/2026", status: "user_provided" },
      { label: "Print da tela do aplicativo mostrando o item contestado", status: "available" },
    ],
    notes: ["Os dados do(a) consumidor(a) não são mantidos pelo sistema e precisam ser preenchidos manualmente."],
    ...overrides,
  };
}

describe("renderDossierPdf", () => {
  it("produces bytes that sniff as a PDF", async () => {
    const { bytes } = await renderAndExtract(baseDossier());
    expect(sniffMimeType(bytes)).toBe("application/pdf");
  });

  it("starts with the %PDF signature", async () => {
    const bytes = await renderDossierPdf(baseDossier());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("%PDF");
  });

  it("includes every section heading", async () => {
    const { text } = await renderAndExtract(baseDossier());
    for (const heading of [
      "Qualificação das partes",
      "A fatura",
      "Itens contestados",
      "Linha do tempo",
      "Lista de anexos",
      "Observações",
    ]) {
      expect(text).toContain(heading);
    }
  });

  it("includes the title block: title, case id, invoice id and generation date", async () => {
    const dossier = baseDossier();
    const { text } = await renderAndExtract(dossier);
    expect(text).toContain(normalizeWhitespace(dossier.title));
    expect(text).toContain(dossier.caseId);
    expect(text).toContain(dossier.invoiceId);
    expect(text).toContain("15/08/2026"); // generatedAt, dd/MM/yyyy
  });

  it("prints a fillable form line for a party whose name is null, one per field", async () => {
    const { text } = await renderAndExtract(baseDossier());
    for (const field of ["Nome completo", "CPF", "Endereço completo", "Telefone", "E-mail"]) {
      expect(text).toContain(field);
    }
    // The point of the block is a visible line to complete by hand, not an
    // empty string — so an underscore rule must actually appear.
    expect(text).toMatch(/_{3,}/);
  });

  it("prints the named party's name and document", async () => {
    const { text } = await renderAndExtract(baseDossier());
    expect(text).toContain("Claro Móvel S.A.");
    expect(text).toContain("[CNPJ]");
  });

  it("states the invoice file was removed, citing fileExpiredAt, when fileAvailable is false", async () => {
    const { text } = await renderAndExtract(baseDossier());
    expect(text).toContain("01/08/2026");
  });

  it("states the invoice file is available when fileAvailable is true, without inventing a removal date", async () => {
    const dossier = baseDossier({
      invoice: { ...baseDossier().invoice, fileAvailable: true, fileExpiredAt: null },
      // The fixture's own attachment list otherwise carries an unrelated
      // "removido" note (a different, still-expired attachment) — cleared
      // here so the assertion below is unambiguously about the invoice
      // section, not a false negative from that unrelated line.
      attachments: [],
    });
    const { text } = await renderAndExtract(dossier);
    expect(text).toContain("Arquivo original da fatura: disponível no sistema.");
    // Must not claim a removal that never happened.
    expect(text).not.toContain("removido");
  });

  it("prints every contested item description, its evidence, and the bold total", async () => {
    const dossier = baseDossier();
    const { text } = await renderAndExtract(dossier);
    for (const item of dossier.contestedItems) {
      expect(text).toContain(normalizeWhitespace(item.description));
      for (const evidence of item.evidence) {
        expect(text).toContain(normalizeWhitespace(evidence));
      }
    }
    expect(text).toContain("R$ 79,89"); // contestedTotalCents = 7989
  });

  it("prints every timeline entry's title and details, in the same relative order as the array", async () => {
    const dossier = baseDossier();
    const { text } = await renderAndExtract(dossier);

    const positions = dossier.entries.map((e) => {
      const idx = text.indexOf(normalizeWhitespace(e.title));
      expect(idx, `expected to find entry title "${e.title}"`).toBeGreaterThanOrEqual(0);
      return idx;
    });
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }

    for (const e of dossier.entries) {
      for (const line of e.details) {
        expect(text).toContain(normalizeWhitespace(line));
      }
    }
  });

  it("prints every attachment label and its pt-BR status word, plus its note when present", async () => {
    const dossier = baseDossier();
    const { text } = await renderAndExtract(dossier);

    for (const attachment of dossier.attachments) {
      expect(text).toContain(normalizeWhitespace(attachment.label));
      if (attachment.note) expect(text).toContain(normalizeWhitespace(attachment.note));
    }
    expect(text).toContain("não está mais disponível no sistema"); // expired
    expect(text).toContain("a providenciar"); // user_provided
    expect(text).toContain("disponível no sistema"); // available (substring of the expired wording too, both must be present)
  });

  it("prints every notes paragraph, and omits the whole section when notes is empty", async () => {
    const withNotes = await renderAndExtract(baseDossier());
    expect(withNotes.text).toContain(normalizeWhitespace(baseDossier().notes[0]!));

    const withoutNotes = await renderAndExtract(baseDossier({ notes: [] }));
    expect(withoutNotes.text).not.toContain("Observações");
  });

  it("preserves a masked marker like [CPF] intact", async () => {
    const { text } = await renderAndExtract(baseDossier());
    expect(text).toContain("[CPF]");
  });

  it("preserves accented pt-BR characters", async () => {
    const { text } = await renderAndExtract(baseDossier());
    for (const ch of ["ç", "ã", "é", "í", "ó", "ú", "â", "ê", "ô", "à"]) {
      expect(text).toContain(ch);
    }
  });

  it("renders an emoji/CJK-carrying detail without throwing, and keeps the surrounding pt-BR text intact", async () => {
    const dossier = baseDossier({
      entries: [
        entry({
          at: new Date("2026-06-01T09:00:00.000Z"),
          title: "Documento editado pelo usuário",
          details: ["Antes do trecho estranho: 😀 中文 depois do trecho, texto normal em português permanece"],
          sourceId: "doc_weird",
        }),
      ],
    });

    await expect(renderDossierPdf(dossier)).resolves.toBeInstanceOf(Uint8Array);

    const { text } = await renderAndExtract(dossier);
    expect(text).toContain("Antes do trecho estranho");
    expect(text).toContain("depois do trecho, texto normal em português permanece");
  });

  it("hard-splits a single word longer than the line instead of overflowing or hanging", async () => {
    const longWord = "a".repeat(400);
    const dossier = baseDossier({
      notes: [`Identificador muito longo: ${longWord} fim.`],
    });

    const { text, totalPages } = await renderAndExtract(dossier);
    expect(totalPages).toBeGreaterThanOrEqual(1);
    expect(text).toContain("Identificador muito longo");
    expect(text).toContain("fim.");
  });

  it("paginates a long timeline without dropping entries, and numbers pages correctly", async () => {
    const manyEntries: DossierEntry[] = Array.from({ length: 60 }, (_, i) =>
      entry({
        at: new Date(Date.UTC(2026, 0, 1 + i)),
        title: `Entrada número ${i + 1} da linha do tempo`,
        details: [`Detalhe A da entrada ${i + 1}`, `Detalhe B da entrada ${i + 1}`],
        sourceId: `evt_${i + 1}`,
      }));

    const dossier = baseDossier({ entries: manyEntries });
    const { text, totalPages } = await renderAndExtract(dossier);

    expect(totalPages).toBeGreaterThan(1);

    // First and last entries alike — this is the assertion that catches
    // silent truncation once the page fills up.
    expect(text).toContain("Entrada número 1 da linha do tempo");
    expect(text).toContain("Entrada número 60 da linha do tempo");
    expect(text).toContain("Detalhe A da entrada 60");
    expect(text).toContain("Detalhe B da entrada 60");

    // Order must still hold across the page break.
    const first = text.indexOf("Entrada número 1 da linha do tempo");
    const last = text.indexOf("Entrada número 60 da linha do tempo");
    expect(last).toBeGreaterThan(first);

    expect(text).toContain(`Página 1 de ${totalPages}`);
    expect(text).toContain(`Página ${totalPages} de ${totalPages}`);
  });

  it("prints the case id in the footer of every page", async () => {
    const manyEntries: DossierEntry[] = Array.from({ length: 60 }, (_, i) =>
      entry({
        at: new Date(Date.UTC(2026, 0, 1 + i)),
        title: `Entrada número ${i + 1}`,
        sourceId: `evt_${i + 1}`,
      }));
    const dossier = baseDossier({ entries: manyEntries });
    const { text, totalPages } = await renderAndExtract(dossier);
    expect(totalPages).toBeGreaterThan(1);
    expect(text).toContain(`Caso ${dossier.caseId}`);
  });

  it("is deterministic apart from PDF's own internal metadata: same input renders the same visible text", async () => {
    const dossier = baseDossier();
    const first = await renderAndExtract(dossier);
    const second = await renderAndExtract(dossier);
    expect(second.text).toBe(first.text);
    expect(second.totalPages).toBe(first.totalPages);
  });
});
