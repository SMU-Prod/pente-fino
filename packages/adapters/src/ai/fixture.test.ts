import { describe, expect, it } from "vitest";
import type { InvoiceCanonical } from "@pentefino/core";
import { createFixtureAiProvider } from "./fixture.js";

const canonical = {
  issuer: { name: "Claro Móvel", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 10000,
  sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
  extraction: { confidence: 0.95, warnings: [] },
} as InvoiceCanonical;

describe("fixture ai provider", () => {
  it("returns the fixture registered for the file key", async () => {
    const ai = createFixtureAiProvider({ "uploads/abc.pdf": canonical });
    const result = await ai.extractInvoice({ fileKey: "uploads/abc.pdf", promptVersion: 1, mode: "text" });
    expect(result.canonical.issuer.name).toBe("Claro Móvel");
  });

  it("validates the fixture through the same Zod schema as the real provider (A7)", async () => {
    const broken = { ...canonical, totalCents: -5 } as InvoiceCanonical;
    const ai = createFixtureAiProvider({ "uploads/bad.pdf": broken });
    await expect(ai.extractInvoice({ fileKey: "uploads/bad.pdf", promptVersion: 1, mode: "text" })).rejects.toThrow();
  });

  it("reports zero cost, so ai_calls stays honest", async () => {
    const ai = createFixtureAiProvider({ "uploads/abc.pdf": canonical });
    const { usage } = await ai.extractInvoice({ fileKey: "uploads/abc.pdf", promptVersion: 1, mode: "text" });
    expect(usage.costUsd).toBe(0);
    expect(usage.provider).toBe("fixture");
  });

  it("fails loudly for an unknown file key instead of inventing an invoice (A8)", async () => {
    const ai = createFixtureAiProvider({});
    await expect(ai.extractInvoice({ fileKey: "uploads/missing.pdf", promptVersion: 1, mode: "text" }))
      .rejects.toThrow(/missing/);
  });

  it("treats a fixture explicitly registered as undefined as invalid input, not as an unregistered key", async () => {
    const ai = createFixtureAiProvider({ "uploads/explicit-undefined.pdf": undefined });

    let thrown: unknown;
    try {
      await ai.extractInvoice({ fileKey: "uploads/explicit-undefined.pdf", promptVersion: 1, mode: "text" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toMatch(/no extraction fixture registered/);
  });
});
