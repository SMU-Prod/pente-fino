import { describe, expect, it } from "vitest";
import { findSensitiveTerm, SENSITIVE_VOCABULARY } from "./sensitive.js";

describe("SENSITIVE_VOCABULARY", () => {
  // Ported verbatim from packages/db/test/invariants/sensitive.spec.ts, the
  // vocabulary's original home — this is the proof the shape survived the
  // move to @pentefino/core untouched.
  it("has vocabulary covering all four categories INV-006 names", () => {
    expect(Object.keys(SENSITIVE_VOCABULARY).sort()).toEqual(["politica", "religiao", "saude", "sindicato"]);
    for (const terms of Object.values(SENSITIVE_VOCABULARY)) expect(terms.length).toBeGreaterThan(0);
  });
});

describe("findSensitiveTerm", () => {
  it("matches accent-insensitively (an accented health term)", () => {
    // The leftmost overall match wins over the earliest-listed alternative:
    // "plano de saude" (a listed multi-word term) starts before the bare
    // "saude" substring nested inside it, so it is what `.exec` returns.
    expect(findSensitiveTerm("Pagamento do plano de saúde mensal")).toBe("plano de saude");
  });

  it("returns null for an ordinary, unrelated description", () => {
    expect(findSensitiveTerm("Assinatura mensal de streaming de música")).toBeNull();
  });

  // --- Documented non-hits (see sensitive.ts's header comment) -----------
  // Each of these is a deliberate exclusion, not an oversight: the bare word
  // is far more likely to be a surname, an unrelated administrative term, or
  // an unrelated everyday use than the sensitive category it resembles.

  it("does not match a bare surname that is also a religious denomination ('batista' alone)", () => {
    expect(findSensitiveTerm("José Batista")).toBeNull();
  });

  it("does not match 'sindicância' (an administrative inquiry, not union membership)", () => {
    expect(findSensitiveTerm("Abertura de sindicância disciplinar")).toBeNull();
  });

  it("does not match 'candidato' (routinely a job applicant, not an electoral one)", () => {
    expect(findSensitiveTerm("Avaliação de candidato para a vaga")).toBeNull();
  });
});
