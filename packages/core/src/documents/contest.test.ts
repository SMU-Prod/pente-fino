import { describe, expect, it } from "vitest";
import { ContestDocument } from "./contest.js";

const valid = {
  subject: "Contestação de cobrança — protocolo 123456",
  body: "x".repeat(250),
  requests: ["Suspensão imediata da cobrança contestada"],
  legalRefs: [{ law: "CDC", article: "art. 42, parágrafo único" }],
  scriptForCall: ["Pedir o número de protocolo"],
  attachmentsChecklist: ["Fatura de julho"],
};

describe("ContestDocument", () => {
  it("accepts a valid document", () => {
    expect(ContestDocument.parse(valid)).toBeTruthy();
  });

  it("rejects a body under 200 characters", () => {
    expect(ContestDocument.safeParse({ ...valid, body: "curto" }).success).toBe(false);
  });

  it("rejects a body over 4000 characters", () => {
    expect(ContestDocument.safeParse({ ...valid, body: "x".repeat(4001) }).success).toBe(false);
  });

  it("requires at least one request", () => {
    expect(ContestDocument.safeParse({ ...valid, requests: [] }).success).toBe(false);
  });

  it("caps requests at six", () => {
    const many = { ...valid, requests: Array.from({ length: 7 }, (_, i) => `pedido ${i}`) };
    expect(ContestDocument.safeParse(many).success).toBe(false);
  });
});
