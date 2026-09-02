import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { join } from "node:path";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extractText, getDocumentProxy } from "unpdf";
import { newId, sniffMimeType } from "@pentefino/core";
import type { ContestDocument } from "@pentefino/core";
import type { Storage } from "@pentefino/core/ports";
import { createLocalStorage } from "@pentefino/adapters";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createDossierTask } from "../src/tasks/dossier.js";

const {
  caseDocuments, caseProtocols, cases, events, findings, invoiceItems, invoices, issuers, rules, users,
} = schema;

/**
 * RF-187's acceptance, end to end and for real: reaching `jec_ready`
 * produces a chronological PDF dossier carrying every document, every
 * protocol and every date, plus the list of attachments — and *the PDF
 * opens and contains them*. So every assertion below reads the bytes the
 * job actually stored back through `unpdf` and looks at the extracted text,
 * never at the `Dossier` value in memory: `buildDossier` and
 * `renderDossierPdf` have their own unit tests, and asserting on their
 * inputs here would gate the wiring while leaving the acceptance itself
 * ungated.
 */

// Fixed reference instant, never the wall clock: it is the only value ever
// passed as `payload.now`, so `generatedAt` (and every date printed from
// it) is deterministic.
const NOW = new Date("2026-08-31T12:00:00.000Z");

// A CPF with valid mod-11 check digits, so `maskText` really does recognise
// it — a made-up 11-digit run would pass this test while masking nothing.
const CPF = "111.444.777-35";
const CPF_DIGITS = "11144477735";

// Claro's real CNPJ, check digits and all. Seeded issuers carry `cnpj:
// null`, so the fixture sets one: a CNPJ identifies a company, not a
// person, and must survive into the dossier unmasked — an assertion with
// nothing to assert on would be worthless.
const ISSUER_CNPJ = "40.432.544/0001-47";

const PROTOCOL_SAC = "20260415-000987654";
const PROTOCOL_PROCON = "PROCON/2026/06/0332";

const EDITED_SUBJECT = "Contestacao revisada pelo titular da linha";
const DISCARDED_SUBJECT = "Rascunho automatico que nao foi utilizado";
const SAC_SUBJECT = "Pedido de cancelamento de servicos adicionais";

const ITEM_STREAMING = "Assinatura de streaming nao solicitada";
const ITEM_WITH_CPF = `Servico adicional vinculado ao CPF ${CPF}`;
const FOREIGN_ITEM = "Cobranca de uma fatura que nao pertence a este caso";

let ctx: TestDb;
let root: string;
let store: Storage;
let issuerId: string;
let ruleId: string;

// Text extraction inserts a line break wherever the layout wrapped, so a
// needle spanning a wrap point would never match a raw `.includes`.
// Collapsing every whitespace run to a single space on both sides of the
// comparison makes every assertion below insensitive to where the renderer
// happened to wrap — same approach as `render-dossier.test.ts`.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function storedFiles(): string[] {
  return readdirSync(root, { recursive: true })
    .map((entry) => join(root, String(entry)))
    .filter((path) => statSync(path).isFile());
}

function task(customStorage?: Storage) {
  return createDossierTask({ db: ctx.db, storage: customStorage ?? store });
}

function contestDocument(overrides: Partial<ContestDocument> = {}): ContestDocument {
  return {
    subject: SAC_SUBJECT,
    body:
      "Prezados, identifiquei na fatura do periodo cobrancas de servicos adicionais que nunca " +
      "solicitei nem utilizei. Peco o cancelamento imediato desses servicos e a devolucao dos " +
      "valores ja pagos, conforme registrado no atendimento indicado nesta carta.",
    requests: ["Cancelar os servicos adicionais nao solicitados", "Devolver os valores ja cobrados"],
    legalRefs: [{ law: "CDC", article: "art. 42, paragrafo unico" }],
    scriptForCall: ["Informar o numero da linha e pedir o numero do protocolo"],
    attachmentsChecklist: ["Comprovante de pagamento da fatura de abril"],
    ...overrides,
  };
}

async function insertInvoice(overrides: {
  createdAt?: Date | undefined;
  // `| undefined` explicitly, under `exactOptionalPropertyTypes`: "absent"
  // and "explicitly null" are different requests here — absent means the
  // default key, null means an invoice whose file RF-110 already deleted.
  fileKey?: string | null | undefined;
} = {}): Promise<string> {
  const id = newId("inv");
  await ctx.db.insert(invoices).values({
    id,
    issuerId,
    contentHash: id,
    source: "pdf_text",
    status: "analyzed",
    periodStart: "2026-04-01",
    periodEnd: "2026-04-30",
    dueDate: "2026-05-10",
    totalCents: 18990,
    createdAt: overrides.createdAt ?? new Date("2026-04-10T09:00:00.000Z"),
    fileKey: overrides.fileKey === undefined ? `uploads/${id}.pdf` : overrides.fileKey,
  });
  return id;
}

/** One `invoice_items` row plus a `findings` row pointing at it. */
async function insertFinding(
  invoiceId: string,
  description: string,
  amountCents: number,
  evidence: string[],
): Promise<string> {
  const itemId = newId("itm");
  await ctx.db.insert(invoiceItems).values({
    id: itemId,
    invoiceId,
    lineNo: 1,
    itemKey: itemId,
    section: "Aplicativos Digitais",
    description,
    normalizedDesc: description.toLowerCase(),
    amountCents,
  });
  const findingId = newId("fnd");
  await ctx.db.insert(findings).values({
    id: findingId, invoiceId, itemId, ruleId, ruleVersion: 1, confidence: 0.82, evidence, amountCents,
  });
  return findingId;
}

/**
 * The rich fixture: an invoice with two flagged items, two documents at
 * different stages (the second edited by the user), two protocols (the
 * first answered), and case- and invoice-scoped events spread across four
 * months so the chronology below is a real one and not three rows that
 * happen to be in insertion order.
 */
async function seedRichCase(overrides: {
  fileKey?: string | null | undefined;
  createdAt?: Date | undefined;
} = {}) {
  const userId = newId("usr");
  await ctx.db.insert(users).values({ id: userId, email: `${userId}@example.com` });

  const invoiceId = await insertInvoice({ fileKey: overrides.fileKey });
  const findingIds = [
    await insertFinding(invoiceId, ITEM_STREAMING, 2990, ["Linha na secao Aplicativos Digitais"]),
    await insertFinding(invoiceId, ITEM_WITH_CPF, 1990, []),
  ];

  const caseId = newId("cas");
  await ctx.db.insert(cases).values({
    id: caseId,
    userId,
    invoiceId,
    issuerId,
    findingIds,
    stage: "jec_ready",
    stageEnteredAt: new Date("2026-07-01T10:00:00.000Z"),
    createdAt: overrides.createdAt ?? new Date("2026-04-12T08:00:00.000Z"),
  });

  await ctx.db.insert(caseDocuments).values([
    {
      id: newId("doc"), caseId, stage: "sac", kind: "sac_script", promptVersion: 1,
      body: contestDocument(),
      userEdited: false,
      createdAt: new Date("2026-04-13T10:00:00.000Z"),
      sentAt: new Date("2026-04-14T11:00:00.000Z"),
    },
    {
      id: newId("doc"), caseId, stage: "procon", kind: "contest_letter", promptVersion: 2,
      body: contestDocument({ subject: DISCARDED_SUBJECT }),
      userEdited: true,
      editedBody: contestDocument({
        subject: EDITED_SUBJECT,
        requests: [`Cancelar o servico associado ao CPF ${CPF}`, "Devolver em dobro o valor cobrado"],
        attachmentsChecklist: [
          "Print da tela do aplicativo mostrando a cobranca",
          // Deliberately identical to the other document's single checklist
          // entry: the attachment list is a union, not a concatenation.
          "Comprovante de pagamento da fatura de abril",
        ],
      }),
      createdAt: new Date("2026-06-01T09:00:00.000Z"),
      sentAt: new Date("2026-06-02T09:00:00.000Z"),
    },
  ]);

  await ctx.db.insert(caseProtocols).values([
    {
      id: newId("prt"), caseId, stage: "sac", protocolNumber: PROTOCOL_SAC, channel: "SAC telefonico",
      registeredAt: new Date("2026-04-15T09:00:00.000Z"),
      responseDueAt: new Date("2026-04-25T09:00:00.000Z"),
      responseReceivedAt: new Date("2026-05-02T14:00:00.000Z"),
      responseSummary: "A empresa negou o cancelamento retroativo dos servicos.",
    },
    {
      id: newId("prt"), caseId, stage: "procon", protocolNumber: PROTOCOL_PROCON, channel: "Procon presencial",
      registeredAt: new Date("2026-06-05T09:00:00.000Z"),
      responseDueAt: new Date("2026-06-20T09:00:00.000Z"),
    },
  ]);

  await ctx.db.insert(events).values([
    // Case-scoped.
    { id: newId("evt"), caseId, invoiceId, userId, type: "case_created", occurredAt: new Date("2026-04-12T08:00:00.000Z") },
    {
      id: newId("evt"), caseId, invoiceId, userId, type: "protocol_entered",
      payload: { protocolNumber: PROTOCOL_SAC }, occurredAt: new Date("2026-04-15T09:05:00.000Z"),
    },
    {
      id: newId("evt"), caseId, invoiceId, userId, type: "deadline_expired",
      payload: { stage: "sac", deadlineAt: "2026-05-20T00:00:00.000Z" },
      occurredAt: new Date("2026-05-20T00:00:00.000Z"),
    },
    {
      id: newId("evt"), caseId, invoiceId, userId, type: "stage_advanced",
      payload: { fromStage: "procon", toStage: "jec_ready" },
      occurredAt: new Date("2026-07-01T10:00:00.000Z"),
    },
    // Invoice-scoped, written before the case existed and carrying no
    // `caseId` at all — the join has to reach these or the timeline starts
    // at the case instead of at the invoice.
    { id: newId("evt"), invoiceId, userId, type: "invoice_uploaded", occurredAt: new Date("2026-04-10T09:00:00.000Z") },
    { id: newId("evt"), invoiceId, userId, type: "invoice_analyzed", occurredAt: new Date("2026-04-11T07:30:00.000Z") },
  ]);

  return { caseId, invoiceId, userId, findingIds };
}

/** Reads the PDF the job stored for `caseId` back out of storage. */
async function readStoredDossier(caseId: string) {
  const [event] = await ctx.db.select().from(events)
    .where(and(eq(events.caseId, caseId), eq(events.type, "dossier_generated")));
  expect(event, "expected a dossier_generated event for the case").toBeDefined();

  const fileKey = event!.payload.fileKey;
  expect(typeof fileKey).toBe("string");

  const stored = await store.get(fileKey as string);
  expect(stored, "expected the dossier bytes to be in storage").not.toBeNull();

  // `getDocumentProxy` (pdfjs underneath) DETACHES the typed array it is
  // handed — hand it a copy, or `stored` becomes a zeroed buffer and
  // `sniffMimeType` below silently sees nothing.
  const pdf = await getDocumentProxy(new Uint8Array(stored!));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });

  return { event: event!, fileKey: fileKey as string, stored: stored!, text: normalizeWhitespace(text), totalPages };
}

async function eventTypes(caseId: string): Promise<string[]> {
  const rows = await ctx.db.select().from(events).where(eq(events.caseId, caseId));
  return rows.map((row) => row.type);
}

beforeEach(async () => {
  ctx = await createTestDb();
  root = mkdtempSync(join(tmpdir(), "pf-dossier-"));
  // One instance for the whole test: `createLocalStorage` keeps its pending
  // signed uploads in a closure, so a `put` on a second instance would be
  // refused as unsigned.
  store = createLocalStorage({ root, secret: "s" });

  const [seeded] = await ctx.db.select({ id: issuers.id }).from(issuers).where(eq(issuers.slug, "claro-movel"));
  if (!seeded) throw new Error("expected createTestDb to seed the claro-movel issuer");
  issuerId = seeded.id;
  await ctx.db.update(issuers).set({ cnpj: ISSUER_CNPJ }).where(eq(issuers.id, issuerId));

  ruleId = newId("rul");
  await ctx.db.insert(rules).values({
    id: ruleId, slug: "dossier-fixture-rule", version: 1, category: "telecom", kind: "pattern",
    spec: { kind: "pattern", match: "SVA" },
    legalBasis: [{ law: "CDC", article: "art. 39, III, p.u.", effect: "vedada" }],
    confidenceBase: 0.8, status: "active", author: "test", reason: "dossier fixture",
  });
});

afterEach(async () => {
  await ctx.close();
  rmSync(root, { recursive: true, force: true });
});

describe("dossier task (RF-187) — the produced PDF", () => {
  it("opens as a PDF and is recorded by a dossier_generated event carrying its fileKey", async () => {
    const { caseId, invoiceId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { event, stored, totalPages, fileKey } = await readStoredDossier(caseId);
    expect(sniffMimeType(stored)).toBe("application/pdf");
    expect(totalPages).toBeGreaterThanOrEqual(1);

    expect(event.invoiceId).toBe(invoiceId);
    expect(event.payload.fileKey).toBe(fileKey);
    expect(event.payload.sizeBytes).toBe(stored.length);
    expect(event.payload.entryCount).toBeGreaterThan(0);
    expect(event.payload.attachmentCount).toBeGreaterThan(0);
    expect(event.payload.invoiceFileAvailable).toBe(true);
  });

  it("carries every protocol number, verbatim and unmasked", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    expect(text).toContain(PROTOCOL_SAC);
    expect(text).toContain(PROTOCOL_PROCON);
    // Also as the attachment line, so the clerk knows which receipt to file.
    expect(text).toContain(`Comprovante do protocolo ${PROTOCOL_SAC} — SAC telefonico, 15/04/2026`);
  });

  it("carries every document subject, using the edited version for an edited document (RF-164)", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    expect(text).toContain(SAC_SUBJECT);
    expect(text).toContain(EDITED_SUBJECT);
    // The version the person replaced is not what happened, so it must not
    // be what a court reads.
    expect(text).not.toContain(DISCARDED_SUBJECT);
  });

  it("carries every date the case holds, in dd/MM/yyyy", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    for (const [date, what] of [
      ["10/04/2026", "invoice received"],
      // Written against the invoice, never against the case: if the events
      // load only joins on caseId, this one is the first thing to vanish.
      ["11/04/2026", "invoice analyzed (invoice-scoped event)"],
      ["12/04/2026", "case opened"],
      ["13/04/2026", "first document generated"],
      ["14/04/2026", "first document sent"],
      ["15/04/2026", "first protocol registered"],
      ["25/04/2026", "first protocol response deadline"],
      ["02/05/2026", "first protocol answered"],
      ["20/05/2026", "deadline expired"],
      ["01/06/2026", "second document generated"],
      ["02/06/2026", "second document sent"],
      ["05/06/2026", "second protocol registered"],
      ["20/06/2026", "second protocol response deadline"],
      ["01/07/2026", "stage advanced to jec_ready"],
      ["31/08/2026", "dossier generated"],
    ] as const) {
      expect(text, `expected the dossier to carry ${what} (${date})`).toContain(date);
    }
  });

  it("orders the timeline chronologically, not in whatever order the rows were loaded", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    // Five entry titles, each appearing exactly once, listed here in the
    // order their own timestamps put them. Presence alone is not a
    // chronology, so this compares positions.
    const inTimeOrder = [
      "Fatura recebida", // 10/04
      "Caso aberto", // 12/04
      "Resposta do protocolo recebida", // 02/05
      "Prazo de resposta esgotado", // 20/05
      "Etapa do caso avançada", // 01/07
    ];

    const positions = inTimeOrder.map((title) => {
      const at = text.indexOf(title);
      expect(at, `expected the timeline to carry "${title}"`).toBeGreaterThanOrEqual(0);
      return at;
    });
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], `"${inTimeOrder[i]}" must come after "${inTimeOrder[i - 1]}"`)
        .toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("carries the attachment list, each label with its pt-BR status, de-duplicated", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    expect(text).toContain("Lista de anexos");
    expect(text).toContain("Fatura do período contestado — disponível no sistema");
    expect(text).toContain(`Comprovante do protocolo ${PROTOCOL_PROCON} — Procon presencial, 05/06/2026 — a providenciar`);
    expect(text).toContain("Print da tela do aplicativo mostrando a cobranca — a providenciar");
    expect(text).toContain("Comprovante de pagamento da fatura de abril — a providenciar");

    // Both documents' checklists name the same receipt; the list is a union.
    const duplicated = "Comprovante de pagamento da fatura de abril — a providenciar";
    expect(text.split(duplicated)).toHaveLength(2);
  });

  it("masks a CPF planted in an item description and in a document body, and leaks the digits nowhere", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    // Control: the digits really are in the database, so the two negative
    // assertions below are about masking and not about a string that was
    // never there to begin with.
    const [item] = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.description, ITEM_WITH_CPF));
    expect(item?.description).toContain(CPF);

    const { text } = await readStoredDossier(caseId);
    expect(text).toContain("Servico adicional vinculado ao CPF [CPF]");
    expect(text).toContain("Pedido: Cancelar o servico associado ao CPF [CPF]");
    expect(text).not.toContain(CPF);
    expect(text).not.toContain(CPF_DIGITS);
  });

  it("prints the issuer's CNPJ unmasked — it identifies a company, not a person", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    expect(text).toContain(ISSUER_CNPJ);
    expect(text).not.toContain("[CNPJ]");
  });

  it("states the original invoice file is still held when it is", async () => {
    const { caseId } = await seedRichCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    expect(text).toContain("Arquivo original da fatura: disponível no sistema.");
    expect(text).not.toContain("removido do armazenamento");
  });
});

describe("dossier task (RF-187) — an invoice whose file RF-110 already deleted", () => {
  async function seedExpiredCase() {
    const seeded = await seedRichCase({ fileKey: null });
    await ctx.db.insert(events).values({
      id: newId("evt"), invoiceId: seeded.invoiceId, userId: seeded.userId,
      type: "invoice_file_expired", occurredAt: new Date("2026-07-15T03:00:00.000Z"),
    });
    return seeded;
  }

  it("says the file is no longer held and names the date it went", async () => {
    const { caseId } = await seedExpiredCase();

    await task()({ now: NOW.toISOString() });

    const { text, event } = await readStoredDossier(caseId);
    expect(text).toContain("Arquivo original da fatura: removido do armazenamento em 15/07/2026.");
    expect(text).not.toContain("Arquivo original da fatura: disponível no sistema");
    expect(event.payload.invoiceFileAvailable).toBe(false);
  });

  it("does not claim the invoice is attached, and still reproduces the invoice's own data", async () => {
    const { caseId } = await seedExpiredCase();

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    expect(text).toContain("Fatura do período contestado — não está mais disponível no sistema");
    expect(text).not.toContain("Fatura do período contestado — disponível no sistema");

    // The file is gone; the data it was extracted from is not (RF-110).
    expect(text).toContain("Período: 01/04/2026 a 30/04/2026");
    expect(text).toContain("Vencimento: 10/05/2026");
    expect(text).toContain("Valor total: R$ 189,90");
    expect(text).toContain(ITEM_STREAMING);
    expect(text).toContain("Total contestado: R$ 49,80");
  });
});

describe("dossier task (RF-187) — eligibility and isolation", () => {
  it("is idempotent: a second run produces no second PDF and no second event (A4)", async () => {
    const { caseId } = await seedRichCase();

    const run = task();
    await run({ now: NOW.toISOString() });
    await run({ now: new Date("2026-09-01T12:00:00.000Z").toISOString() });

    const types = await eventTypes(caseId);
    expect(types.filter((type) => type === "dossier_generated")).toHaveLength(1);
    expect(types).not.toContain("dossier_generation_failed");
    expect(storedFiles()).toHaveLength(1);
  });

  it("ignores a case that has not reached jec_ready", async () => {
    const { caseId } = await seedRichCase();
    await ctx.db.update(cases).set({ stage: "sac" }).where(eq(cases.id, caseId));

    await task()({ now: NOW.toISOString() });

    expect(await eventTypes(caseId)).not.toContain("dossier_generated");
    expect(storedFiles()).toHaveLength(0);
  });

  it("does not let one case's storage failure sink the run for the next case (A8)", async () => {
    const first = await seedRichCase({ createdAt: new Date("2026-04-12T08:00:00.000Z") });
    const second = await seedRichCase({ createdAt: new Date("2026-04-13T08:00:00.000Z") });

    let puts = 0;
    const flaky: Storage = {
      ...store,
      async put(fileKey, body) {
        puts += 1;
        if (puts === 1) throw new Error("simulated storage outage");
        return store.put(fileKey, body);
      },
    };

    await task(flaky)({ now: NOW.toISOString() });

    const firstTypes = await eventTypes(first.caseId);
    expect(firstTypes).toContain("dossier_generation_failed");
    expect(firstTypes).not.toContain("dossier_generated");

    // The whole point: the second case's outcome is untouched by the first's.
    const secondTypes = await eventTypes(second.caseId);
    expect(secondTypes).toContain("dossier_generated");
    const { totalPages } = await readStoredDossier(second.caseId);
    expect(totalPages).toBeGreaterThanOrEqual(1);
  });

  it("retries a failed case on the next run, because no dossier_generated was written for it", async () => {
    const { caseId } = await seedRichCase();

    let puts = 0;
    const flaky: Storage = {
      ...store,
      async put(fileKey, body) {
        puts += 1;
        if (puts === 1) throw new Error("simulated storage outage");
        return store.put(fileKey, body);
      },
    };

    await task(flaky)({ now: NOW.toISOString() });
    await task(flaky)({ now: NOW.toISOString() });

    const types = await eventTypes(caseId);
    expect(types.filter((type) => type === "dossier_generation_failed")).toHaveLength(1);
    expect(types.filter((type) => type === "dossier_generated")).toHaveLength(1);
  });

  it("does not let a finding from another invoice smuggle a row into a court document", async () => {
    const { caseId, findingIds } = await seedRichCase();

    const otherInvoiceId = await insertInvoice();
    const foreignFindingId = await insertFinding(otherInvoiceId, FOREIGN_ITEM, 9990, ["Evidencia estranha ao caso"]);
    await ctx.db.update(cases)
      .set({ findingIds: [...findingIds, foreignFindingId] })
      .where(eq(cases.id, caseId));

    await task()({ now: NOW.toISOString() });

    const { text } = await readStoredDossier(caseId);
    expect(text).not.toContain(FOREIGN_ITEM);
    expect(text).not.toContain("Evidencia estranha ao caso");
    // Control: the case's own findings did reach the document, so the
    // assertion above is about the invoice filter and not about an empty
    // contested list.
    expect(text).toContain(ITEM_STREAMING);
    expect(text).toContain("Total contestado: R$ 49,80");
  });
});
