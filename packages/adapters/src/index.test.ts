import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapters } from "./index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-adapters-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildAdapters", () => {
  it("wires the local adapters when no real credentials are configured", () => {
    const adapters = buildAdapters({ LOCAL_DATA_ROOT: root });
    expect(adapters.storage).toBeDefined();
    expect(adapters.queue).toBeDefined();
    expect(adapters.ai).toBeDefined();
    expect(adapters.mailer).toBeDefined();
  });

  it("wires the given task handlers into the queue", async () => {
    const handler = vi.fn(async () => {});
    const adapters = buildAdapters({ LOCAL_DATA_ROOT: root }, { ingest: handler });
    await adapters.queue.enqueue("ingest", { a: 1 });
    expect(handler).toHaveBeenCalledWith({ a: 1 });
  });

  it("wires the given fixtures into the ai provider", async () => {
    const canonical = {
      issuer: { name: "Claro Móvel", category: "telecom" },
      period: { start: "2026-07-01", end: "2026-07-31" },
      dueDate: "2026-08-10",
      totalCents: 10000,
      sections: [{ name: "Serviços", items: [{ description: "Plano", amountCents: 10000 }] }],
      extraction: { confidence: 0.95, warnings: [] },
    };
    const adapters = buildAdapters({ LOCAL_DATA_ROOT: root }, {}, { "uploads/abc.pdf": canonical });
    const result = await adapters.ai.extractInvoice({
      fileKey: "uploads/abc.pdf", promptVersion: 1, promptBody: "extract everything verbatim", mode: "text",
    });
    expect(result.canonical.issuer.name).toBe("Claro Móvel");
  });

  it("throws naming R2_ACCESS_KEY_ID when a real storage credential is present but unimplemented", () => {
    expect(() => buildAdapters({ LOCAL_DATA_ROOT: root, R2_ACCESS_KEY_ID: "x" })).toThrow(/R2_ACCESS_KEY_ID/);
  });

  it("throws naming TRIGGER_SECRET_KEY when a real queue credential is present but unimplemented", () => {
    expect(() => buildAdapters({ LOCAL_DATA_ROOT: root, TRIGGER_SECRET_KEY: "x" })).toThrow(/TRIGGER_SECRET_KEY/);
  });

  // E1, Task 7: the real AI Gateway provider now exists, so setting
  // AI_GATEWAY_API_KEY must wire it in rather than throw - this replaces
  // the E0-era test that asserted the opposite, back when no real ai
  // adapter existed yet.
  it("wires the real gateway ai provider when AI_GATEWAY_API_KEY is set, instead of throwing", () => {
    const adapters = buildAdapters({ LOCAL_DATA_ROOT: root, AI_GATEWAY_API_KEY: "x" });
    expect(adapters.ai).toBeDefined();
  });

  it("throws naming RESEND_API_KEY when a real mailer credential is present but unimplemented", () => {
    expect(() => buildAdapters({ LOCAL_DATA_ROOT: root, RESEND_API_KEY: "x" })).toThrow(/RESEND_API_KEY/);
  });

  it("does not throw for unrelated environment variables", () => {
    expect(() => buildAdapters({ LOCAL_DATA_ROOT: root, PATH: "/usr/bin", NODE_ENV: "test" })).not.toThrow();
  });
});
