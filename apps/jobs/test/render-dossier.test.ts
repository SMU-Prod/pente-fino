import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
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
        // A realistic, unmasked CNPJ — buildDossier sets this field to
        // input.issuer.cnpj raw (packages/core/src/documents/dossier.ts),
        // never through maskText. "[CNPJ]" would be what maskText produces
        // for free text, which this field never is; using it here would
        // make this fixture document behaviour the system does not have.
        document: "12.345.678/0001-90",
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
        // Deliberately worded differently from "A fatura" section's own
        // "Período: ... a ..." / "Valor total: ..." lines (same underlying
        // numbers, different sentence) so this test's per-entry assertions
        // are anchored to the timeline block specifically, not satisfied by
        // a byte-identical line the invoice section renders elsewhere.
        details: ["Referente ao período 01/06/2026–30/06/2026", "Valor cobrado: R$ 159,90"],
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
    // Anchored to the title block's own back-to-back layout ("Caso X"
    // immediately followed by "Fatura Y"), not the bare case id — the
    // footer also draws "Caso <id>" on every page, so a bare
    // `toContain(dossier.caseId)` would still pass with the whole title
    // block deleted (only the generation date line below is unique to it).
    expect(text).toContain(`Caso ${dossier.caseId} Fatura ${dossier.invoiceId}`);
    expect(text).toContain("Documento gerado em 15/08/2026"); // generatedAt, dd/MM/yyyy
  });

  it("prints a fillable form line for a party whose name is null, one per field", async () => {
    const { text } = await renderAndExtract(baseDossier());
    for (const field of ["Nome completo", "CPF", "Endereço completo", "Telefone", "E-mail"]) {
      // Anchored to the actual form line ("Field: ___"), not the bare
      // label — "CPF" alone is also a substring of the "[CPF]" masked
      // markers elsewhere in the fixture, so a bare toContain would not
      // prove this field produced its own fillable line.
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(text).toMatch(new RegExp(`${escaped}: _{3,}`));
    }
  });

  it("prints the named party's name and document", async () => {
    const { text } = await renderAndExtract(baseDossier());
    // Anchored to the rendered "Nome:"/"Documento:" lines, not the bare
    // values — "Claro Móvel S.A." also appears via the invoice section's
    // "Prestadora: ..." line (same issuer name, different sentence), so a
    // bare toContain would still pass with the party's own name line
    // deleted entirely.
    expect(text).toContain("Nome: Claro Móvel S.A.");
    expect(text).toContain("Documento: 12.345.678/0001-90");
  });

  it("states the invoice file was removed, citing fileExpiredAt, when fileAvailable is false", async () => {
    const { text } = await renderAndExtract(baseDossier());
    // Assert the whole sentence, not the bare date — the fixture's own
    // attachments[0].note repeats "01/08/2026" for an unrelated reason (the
    // attachment section, not the invoice section), so a bare date would
    // still pass with invoiceFileLine's call deleted entirely. Same pattern
    // as the sibling "fileAvailable is true" test below.
    expect(text).toContain("Arquivo original da fatura: removido do armazenamento em 01/08/2026.");
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
    // The brief asks for "description, right-aligned amount" — the amount
    // half was previously unasserted (drawLabelWithRightValue's value draw
    // could be deleted and this test would not notice).
    expect(text).toContain("R$ 49,90"); // contestedItems[0].amountCents = 4990
    expect(text).toContain("R$ 29,99"); // contestedItems[1].amountCents = 2999
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

    // Anchor each status word to its own attachment's full rendered line
    // (marker + label + status), not the bare status phrase — the
    // `available` wording ("disponível no sistema") is itself a substring
    // of the `expired` wording ("não está mais disponível no sistema"), so
    // a bare toContain for `available` would still pass even if its own
    // label were changed to something else entirely. The `[x]`/`[ ]`
    // marker (brief: "a checkbox-ish marker") comes along for free.
    expect(text).toContain("[ ] Fatura do período contestado — não está mais disponível no sistema"); // expired
    expect(text).toContain("[ ] Comprovante do protocolo 12345 — telefone, 20/06/2026 — a providenciar"); // user_provided
    expect(text).toContain("[x] Print da tela do aplicativo mostrando o item contestado — disponível no sistema"); // available
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

    const { text } = await renderAndExtract(dossier);
    expect(text).toContain("Identificador muito longo");
    expect(text).toContain("fim.");
    // The two assertions above pass even without splitting — the words
    // before and after the long word are drawn regardless of what happens
    // to it. What actually distinguishes a hard split from drawing the
    // word whole (this test's named mutation): verified by hand, pdf.js's
    // text extraction silently truncates a single text-show operation that
    // runs far past the page's content width — an unmutated 400-char draw
    // comes back as only ~99 characters, the rest simply gone, with no
    // error of any kind. A correct hard split keeps every line within
    // maxWidth, so every "a" survives extraction. Summing every run of 20+
    // consecutive "a"s (long enough that nothing else in the fixture's
    // pt-BR text could produce one, split or not) must equal all 400 of
    // them.
    const survivingChars = [...text.matchAll(/a{20,}/g)].reduce((sum, m) => sum + m[0].length, 0);
    expect(survivingChars).toBe(400);
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

    // First, middle and last entries alike — this is the assertion that
    // catches silent truncation once the page fills up. First and last
    // alone would not catch a drop confined to the middle of the array
    // (e.g. a slice that kept only the two ends) as long as the page count
    // still came out greater than one.
    expect(text).toContain("Entrada número 1 da linha do tempo");
    expect(text).toContain("Entrada número 30 da linha do tempo");
    expect(text).toContain("Detalhe A da entrada 30");
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
    const bytes = await renderDossierPdf(dossier);
    const pdf = await getDocumentProxy(bytes.slice());
    // Per-page extraction, not merged: the title block draws "Caso <id>"
    // exactly once, on page 1 only. With `mergePages: true` that single
    // occurrence would satisfy `toContain` for the whole document, so
    // "every page" was never actually checked even in principle — and
    // deleting the footer's own case-id draw would still leave the title
    // block's occurrence to pass a merged assertion.
    const { text: pages, totalPages } = await extractText(pdf, { mergePages: false });
    expect(totalPages).toBeGreaterThan(1);
    expect(pages).toHaveLength(totalPages);
    for (const pageText of pages) {
      expect(normalizeWhitespace(pageText)).toContain(`Caso ${dossier.caseId}`);
    }
  });

  it("formats money for zero, negative and four-digit amounts (thousands separator)", async () => {
    // Every amount elsewhere in the fixture is between 2999 and 15990
    // cents, so none of them exercise the thousands separator, a negative
    // (credit-line) amount or zero — all three explicitly required by the
    // brief ("Handle zero and negative values... a credit line is a real
    // thing on an invoice").
    const dossier = baseDossier({
      contestedItems: [
        { description: "Item de valor elevado", amountCents: 123456, evidence: [] },
        { description: "Estorno de cobrança em duplicidade", amountCents: -150, evidence: [] },
        { description: "Item sem custo associado", amountCents: 0, evidence: [] },
      ],
      contestedTotalCents: 123456 - 150 + 0,
    });
    const { text } = await renderAndExtract(dossier);
    expect(text).toContain("R$ 1.234,56");
    expect(text).toContain("-R$ 1,50");
    expect(text).toContain("R$ 0,00");
  });

  it("sets the PDF's creation and modification dates from dossier.generatedAt, not the wall clock", async () => {
    const dossier = baseDossier();
    const bytes = await renderDossierPdf(dossier);
    const pdf = await getDocumentProxy(bytes.slice());
    const { info } = await getMeta(pdf);
    // dossier.generatedAt = 2026-08-15T10:00:00.000Z; pdf-lib's PDFString.fromDate
    // formats this as "D:YYYYMMDDHHMMSSZ" from the date's own UTC fields.
    expect(info.CreationDate).toBe("D:20260815100000Z");
    expect(info.ModDate).toBe("D:20260815100000Z");
  });

  it("is deterministic apart from PDF's own internal metadata: same input renders the same visible text", async () => {
    const dossier = baseDossier();
    const first = await renderAndExtract(dossier);
    const second = await renderAndExtract(dossier);
    expect(second.text).toBe(first.text);
    expect(second.totalPages).toBe(first.totalPages);
  });
});
