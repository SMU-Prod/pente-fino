import { describe, expect, it } from "vitest";
import { detectIssuer, type IssuerCandidate } from "./detect-issuer.js";

const candidates: IssuerCandidate[] = [
  { id: "iss_claro", slug: "claro-movel", displayName: "Claro Móvel",
    cnpj: "40432544000147", aliases: ["Claro", "Claro S.A."] },
  { id: "iss_vivo", slug: "vivo-movel", displayName: "Vivo",
    cnpj: "02558157000162", aliases: ["Vivo", "Telefônica Brasil"] },
  { id: "iss_tim", slug: "tim-movel", displayName: "TIM",
    cnpj: "02421421000111", aliases: ["TIM", "TIM S.A."] },
];

describe("detectIssuer", () => {
  it("matches on the CNPJ, which is the strongest signal", () => {
    const m = detectIssuer("CNPJ 40.432.544/0001-47 fatura", candidates);
    expect(m.issuerId).toBe("iss_claro");
    expect(m.matchedOn).toBe("cnpj");
  });

  it("matches an unformatted CNPJ too", () => {
    expect(detectIssuer("cnpj 02421421000111", candidates).issuerId).toBe("iss_tim");
  });

  it("falls back to an alias in the header", () => {
    const m = detectIssuer("VIVO\nFatura de julho", candidates);
    expect(m.issuerId).toBe("iss_vivo");
    expect(m.matchedOn).toBe("alias");
  });

  it("ignores accents and case when matching a name", () => {
    expect(detectIssuer("claro movel — fatura", candidates).issuerId).toBe("iss_claro");
  });

  it("returns unknown rather than guessing when nothing matches", () => {
    const m = detectIssuer("Cooperativa Regional de Telefonia", candidates);
    expect(m.issuerId).toBeNull();
    expect(m.matchedOn).toBe("none");
    expect(m.confidence).toBe(0);
  });

  it("prefers the CNPJ when an alias points somewhere else", () => {
    const text = "Fatura Vivo — cobrança processada por CNPJ 40.432.544/0001-47";
    const m = detectIssuer(text, candidates);
    expect(m.issuerId).toBe("iss_claro");
    expect(m.matchedOn).toBe("cnpj");
  });

  it("returns unknown when two aliases match and no CNPJ decides", () => {
    const m = detectIssuer("Portabilidade de TIM para Vivo", candidates);
    expect(m.issuerId).toBeNull();
  });

  it("does not match an alias inside a longer word", () => {
    expect(detectIssuer("Declaração de vivos e falecidos", candidates).issuerId).toBeNull();
  });

  it("only looks at the head of the document, where the letterhead is", () => {
    const buried = `${"linha irrelevante\n".repeat(400)}CLARO MÓVEL`;
    expect(detectIssuer(buried, candidates).issuerId).toBeNull();
  });

  it("does not let two unrelated numeric fields concatenate into a false CNPJ", () => {
    const text =
      "Fatura de telefonia\n" +
      "Nº do documento: 4043254\n" +
      "Código de barras: 4000147\n" +
      "Nenhuma operadora identificada no cabeçalho.";
    const m = detectIssuer(text, candidates);
    expect(m.issuerId).toBeNull();
    expect(m.matchedOn).toBe("none");
  });

  it("still matches a properly formatted CNPJ with dots, a slash and a hyphen", () => {
    const m = detectIssuer("CNPJ 02.558.157/0001-62 fatura", candidates);
    expect(m.issuerId).toBe("iss_vivo");
    expect(m.matchedOn).toBe("cnpj");
  });

  it("still matches an unformatted, contiguous fourteen-digit CNPJ", () => {
    const m = detectIssuer("cnpj 02558157000162 fatura", candidates);
    expect(m.issuerId).toBe("iss_vivo");
    expect(m.matchedOn).toBe("cnpj");
  });

  it("still matches a CNPJ written with spaces between the digit groups", () => {
    const m = detectIssuer("TIM S.A.\nCNPJ 02 421 421 0001 11\nFatura de julho/2026", candidates);
    expect(m.issuerId).toBe("iss_tim");
    expect(m.matchedOn).toBe("cnpj");
  });

  it("does not match a fourteen-digit CNPJ window inside a longer digit run", () => {
    const text = "Nosso protocolo de atendimento é 404325440001470, guarde para futuras consultas.";
    const m = detectIssuer(text, candidates);
    expect(m.issuerId).toBeNull();
    expect(m.matchedOn).toBe("none");
  });

  it("does not bridge a CNPJ split across a line break", () => {
    // No alias text here on purpose: the point is to isolate the CNPJ path
    // from the alias path, so a match could only come from bridging the
    // newline inside "40.432.544/\n0001-47".
    const text = "Fatura de serviços de telecomunicações\nCNPJ 40.432.544/\n0001-47\nJulho/2026";
    const m = detectIssuer(text, candidates);
    expect(m.issuerId).toBeNull();
    expect(m.matchedOn).toBe("none");
  });
});
