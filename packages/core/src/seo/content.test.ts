import { describe, expect, it } from "vitest";
import type { SeoPageContent } from "./content.js";
import {
  isSeoChargeSlug,
  parseSeoContent,
  SEO_FAQ_HEADING,
  SEO_PROVENANCE_HEADING,
  SeoContentParseError,
  seoChargeSlug,
  serializeSeoContent,
} from "./content.js";

/**
 * The round trip is the contract: whatever `serializeSeoContent` writes into
 * `seo_pages.body_md`, `parseSeoContent` must read back byte-for-byte as the
 * same value, because the route (E10 Task 3) renders exactly what the parser
 * returns and nothing else. Each fixture below exercises one shape the
 * corpus (E10 Task 2) is expected to lean on.
 */
// `satisfies` (not a `: Record<...>` annotation) keeps each key's literal
// type, so `FIXTURES.minimal` below is `SeoPageContent`, not
// `SeoPageContent | undefined` — this package's `noUncheckedIndexedAccess`
// only widens actual index-signature access, not a known property name.
const FIXTURES = {
  minimal: {
    intro: "Esta linha aparece em faturas de telecom como um serviço avulso.",
    sections: [
      {
        heading: "O que é essa cobrança",
        paragraphs: ["É um serviço de terceiro, vendido junto com o plano."],
      },
    ],
    faq: [],
    provenance: "Conteúdo reunido a partir de reclamações públicas e páginas oficiais.",
  },

  "multiple paragraphs per section": {
    intro: "Um segundo exemplo, com mais texto por seção.",
    sections: [
      {
        heading: "Como isso chega na fatura",
        paragraphs: [
          "Primeiro parágrafo explicando o mecanismo.",
          "Segundo parágrafo com mais detalhe sobre o mesmo mecanismo.",
          "Terceiro parágrafo, ainda na mesma seção.",
        ],
      },
      {
        heading: "O que a norma diz",
        paragraphs: ["A Resolução 765/2023 da Anatel trata do assunto."],
      },
    ],
    faq: [
      { question: "Isso é golpe?", answer: "Não necessariamente — pode ser um serviço contratado." },
      { question: "Como eu cancelo?", answer: "Pelo aplicativo da operadora ou pelo 10 do SAC." },
    ],
    provenance: "Conteúdo reunido a partir de reclamações públicas e páginas oficiais.",
  },

  "empty FAQ": {
    intro: "Terceiro exemplo, sem nenhuma pergunta frequente cadastrada.",
    sections: [
      { heading: "O que é essa cobrança", paragraphs: ["Texto único da seção."] },
    ],
    faq: [],
    provenance: "Conteúdo reunido a partir de reclamações públicas e páginas oficiais.",
  },

  "no sections, only FAQ and provenance": {
    intro: "Quarto exemplo, direto ao ponto, sem seção intermediária.",
    sections: [],
    faq: [{ question: "Pergunta única?", answer: "Resposta única." }],
    provenance: "Conteúdo reunido a partir de reclamações públicas e páginas oficiais.",
  },

  "nothing but intro and provenance": {
    intro: "Quinto exemplo: nem seção, nem FAQ.",
    sections: [],
    faq: [],
    provenance: "Conteúdo reunido a partir de reclamações públicas e páginas oficiais.",
  },

  "a # character mid-sentence": {
    intro: "O item aparece como #123 na fatura, junto com outros números de série.",
    sections: [
      {
        heading: "Onde encontrar o item #123",
        paragraphs: [
          "Procure a linha que cita #123 no detalhamento de serviços.",
          "Se não encontrar #123 exatamente, procure por variações do nome.",
        ],
      },
    ],
    faq: [
      {
        question: "O código #123 muda de operadora para operadora?",
        answer: "Sim, o número #123 usado aqui é só um exemplo ilustrativo.",
      },
    ],
    provenance: "Este texto cita #123 apenas como exemplo — não é um código real de nenhuma operadora.",
  },
} satisfies Record<string, SeoPageContent>;

describe("round trip: parseSeoContent(serializeSeoContent(c)) deep-equals c", () => {
  for (const [name, content] of Object.entries(FIXTURES)) {
    it(name, () => {
      const markdown = serializeSeoContent(content);
      expect(parseSeoContent(markdown)).toEqual(content);
    });
  }
});

describe("serializeSeoContent", () => {
  it("emits exactly the narrow markdown subset: ## / ### headings and blank-line-separated paragraphs", () => {
    const markdown = serializeSeoContent(FIXTURES.minimal);
    expect(markdown).toBe(
      [
        "Esta linha aparece em faturas de telecom como um serviço avulso.",
        "",
        "## O que é essa cobrança",
        "",
        "É um serviço de terceiro, vendido junto com o plano.",
        "",
        `## ${SEO_PROVENANCE_HEADING}`,
        "",
        "Conteúdo reunido a partir de reclamações públicas e páginas oficiais.",
      ].join("\n"),
    );
  });

  it("omits the FAQ heading entirely when there are no FAQ entries", () => {
    const markdown = serializeSeoContent(FIXTURES.minimal);
    expect(markdown).not.toContain(SEO_FAQ_HEADING);
  });

  it("renders the FAQ under the fixed heading, each entry as h3 + paragraph, in order", () => {
    const markdown = serializeSeoContent(FIXTURES["no sections, only FAQ and provenance"]);
    const faqIndex = markdown.indexOf(`## ${SEO_FAQ_HEADING}`);
    const questionIndex = markdown.indexOf("### Pergunta única?");
    const provenanceIndex = markdown.indexOf(`## ${SEO_PROVENANCE_HEADING}`);
    expect(faqIndex).toBeGreaterThanOrEqual(0);
    expect(questionIndex).toBeGreaterThan(faqIndex);
    expect(provenanceIndex).toBeGreaterThan(questionIndex);
  });

  it("puts the provenance block last", () => {
    const markdown = serializeSeoContent(FIXTURES["multiple paragraphs per section"]);
    const provenanceIndex = markdown.indexOf(`## ${SEO_PROVENANCE_HEADING}`);
    expect(provenanceIndex).toBeGreaterThan(0);
    expect(markdown.endsWith(FIXTURES["multiple paragraphs per section"].provenance)).toBe(true);
  });
});

describe("parseSeoContent: rejects anything it cannot round-trip", () => {
  it("rejects an unknown block type (a level of heading outside ## / ###)", () => {
    const markdown = [
      "Introdução válida.",
      "",
      "# Título de nível 1, fora do subconjunto",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/unknown block type/i);
  });

  it("rejects a heading and body glued together with no blank line between them", () => {
    const markdown = [
      "Introdução válida.",
      "",
      "## Seção\nCorpo colado, sem linha em branco",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
  });

  it("rejects a ### heading outside the FAQ section", () => {
    const markdown = [
      "Introdução válida.",
      "",
      "## Seção",
      "",
      "Corpo da seção, para que o rejeite seja por causa do ### e não por falta de corpo.",
      "",
      "### Isso não deveria estar aqui",
      "",
      "Corpo.",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/### heading outside the FAQ section/i);
  });

  it("rejects a section heading with no body", () => {
    const markdown = [
      "Introdução válida.",
      "",
      "## Seção sem corpo",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/heading with no body/i);
  });

  it("rejects the FAQ heading with no questions under it", () => {
    const markdown = [
      "Introdução válida.",
      "",
      `## ${SEO_FAQ_HEADING}`,
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/heading with no body/i);
  });

  it("rejects a FAQ question with no answer", () => {
    const markdown = [
      "Introdução válida.",
      "",
      `## ${SEO_FAQ_HEADING}`,
      "",
      "### Pergunta sem resposta",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/heading with no body/i);
  });

  it("rejects the provenance heading with no body", () => {
    const markdown = ["Introdução válida.", "", `## ${SEO_PROVENANCE_HEADING}`].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/heading with no body/i);
  });

  it("rejects content after the provenance block", () => {
    const markdown = [
      "Introdução válida.",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
      "",
      "Isso não deveria estar aqui.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/provenance section, which must be the last block/i);
  });

  it("rejects a document missing the provenance section entirely", () => {
    const markdown = ["Introdução válida.", "", "## Seção", "", "Corpo."].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/provenance/i);
  });

  it("rejects a heading where the intro paragraph is expected", () => {
    const markdown = ["## Isso deveria ser a introdução", "", "Corpo.", "", `## ${SEO_PROVENANCE_HEADING}`, "", "Proveniência."].join(
      "\n",
    );
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/expected the intro paragraph/i);
  });

  it("rejects a paragraph where a heading was expected", () => {
    const markdown = [
      "Introdução válida.",
      "",
      "Um parágrafo solto, sem heading nenhum antes dele.",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
    expect(() => parseSeoContent(markdown)).toThrow(/expected a heading/i);
  });

  it("rejects the FAQ heading appearing a second time", () => {
    const markdown = [
      "Introdução válida.",
      "",
      `## ${SEO_FAQ_HEADING}`,
      "",
      "### Pergunta",
      "",
      "Resposta.",
      "",
      `## ${SEO_FAQ_HEADING}`,
      "",
      "### Outra pergunta",
      "",
      "Outra resposta.",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
  });

  it("rejects a section heading appearing after the FAQ section", () => {
    const markdown = [
      "Introdução válida.",
      "",
      `## ${SEO_FAQ_HEADING}`,
      "",
      "### Pergunta",
      "",
      "Resposta.",
      "",
      "## Seção fora de ordem",
      "",
      "Corpo.",
      "",
      `## ${SEO_PROVENANCE_HEADING}`,
      "",
      "Proveniência.",
    ].join("\n");
    expect(() => parseSeoContent(markdown)).toThrow(SeoContentParseError);
  });

  it("rejects empty markdown", () => {
    expect(() => parseSeoContent("")).toThrow(SeoContentParseError);
    expect(() => parseSeoContent("   \n\n  ")).toThrow(SeoContentParseError);
  });
});

describe("seoChargeSlug: the shape shared between the seed and the route", () => {
  it("accepts lowercase, digits and internal single dashes", () => {
    expect(seoChargeSlug("skeelo")).toBe("skeelo");
    expect(seoChargeSlug("servicos-digitais-iii")).toBe("servicos-digitais-iii");
    expect(seoChargeSlug("mcafee2026")).toBe("mcafee2026");
  });

  it("rejects uppercase letters", () => {
    expect(() => seoChargeSlug("Skeelo")).toThrow(RangeError);
  });

  it("rejects a leading dash", () => {
    expect(() => seoChargeSlug("-skeelo")).toThrow(RangeError);
  });

  it("rejects a trailing dash", () => {
    expect(() => seoChargeSlug("skeelo-")).toThrow(RangeError);
  });

  it("rejects a double dash", () => {
    expect(() => seoChargeSlug("skeelo--promo")).toThrow(RangeError);
  });

  it("rejects an empty string", () => {
    expect(() => seoChargeSlug("")).toThrow(RangeError);
  });

  it("rejects characters outside a-z0-9-, such as spaces, underscores and accents", () => {
    expect(() => seoChargeSlug("skeelo promo")).toThrow(RangeError);
    expect(() => seoChargeSlug("skeelo_promo")).toThrow(RangeError);
    expect(() => seoChargeSlug("promoção")).toThrow(RangeError);
  });

  it("isSeoChargeSlug mirrors seoChargeSlug without throwing", () => {
    expect(isSeoChargeSlug("claro-movel")).toBe(true);
    expect(isSeoChargeSlug("Claro-Movel")).toBe(false);
    expect(isSeoChargeSlug("")).toBe(false);
  });
});
