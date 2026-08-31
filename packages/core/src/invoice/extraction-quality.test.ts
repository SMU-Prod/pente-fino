import { describe, expect, it } from "vitest";
import { extractionQuality } from "./extraction-quality.js";

const goodPage = [
  "CLARO MÓVEL",
  "CNPJ 40.432.544/0001-47",
  "Total a pagar R$ 129,90",
  "Vencimento 10/08/2026",
  "Plano pós-pago 20GB .......... 99,90",
  "Serviços Digitais .......... 30,00",
].join("\n");

describe("extractionQuality", () => {
  it("scores a clean invoice page above the vision threshold", () => {
    const q = extractionQuality({ pages: [goodPage], pageCount: 1, hasTextLayer: true });
    expect(q.score).toBeGreaterThanOrEqual(0.6);
    expect(q.route).toBe("text");
  });

  it("routes a scan with no text layer to vision", () => {
    const q = extractionQuality({ pages: [""], pageCount: 1, hasTextLayer: false });
    expect(q.score).toBe(0);
    expect(q.route).toBe("vision");
  });

  it("finds the three anchor fields when they are present", () => {
    const q = extractionQuality({ pages: [goodPage], pageCount: 1, hasTextLayer: true });
    expect(q.signals.anchorsFound).toEqual(
      expect.arrayContaining(["total", "due_date", "cnpj"]),
    );
  });

  it("finds no anchors in prose that is not an invoice", () => {
    const q = extractionQuality({
      pages: ["Prezado cliente, agradecemos a preferência."],
      pageCount: 1,
      hasTextLayer: true,
    });
    expect(q.signals.anchorsFound).toEqual([]);
  });

  it("routes OCR noise to vision even though it has a text layer", () => {
    const noise = "l1I| ~~ @@ ### ¬¬ ‰‰ ¤¤ §§ ±± ¶¶ ††";
    const q = extractionQuality({ pages: [noise], pageCount: 1, hasTextLayer: true });
    expect(q.route).toBe("vision");
  });

  it("penalises a page with a text layer but almost no text", () => {
    const q = extractionQuality({ pages: ["Claro"], pageCount: 1, hasTextLayer: true });
    expect(q.score).toBeLessThan(0.6);
  });

  it("averages density across pages rather than reading only the first", () => {
    const doc = { pages: [goodPage, ""], pageCount: 2, hasTextLayer: true };
    const q = extractionQuality(doc);
    expect(q.signals.densityPerPage).toBeLessThan(
      extractionQuality({ pages: [goodPage], pageCount: 1, hasTextLayer: true })
        .signals.densityPerPage,
    );
  });

  it("keeps the score inside 0..1", () => {
    const long = Array.from({ length: 40 }, () => goodPage).join("\n");
    const q = extractionQuality({ pages: [long], pageCount: 1, hasTextLayer: true });
    expect(q.score).toBeGreaterThanOrEqual(0);
    expect(q.score).toBeLessThanOrEqual(1);
  });

  it("uses 0,6 as the threshold RF-107 names", () => {
    const borderline = extractionQuality({
      pages: ["Total R$ 10,00"],
      pageCount: 1,
      hasTextLayer: true,
    });
    expect(borderline.route).toBe(borderline.score >= 0.6 ? "text" : "vision");
  });
});
