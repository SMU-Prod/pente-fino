import { seoChargeSlug, type SeoPageContent, type SeoSection } from "@pentefino/core";

/**
 * The corpus itself: every page E10 publishes at
 * `/cobranca/[issuer]/[charge]`, authored here as `SeoPageContent` values
 * and written to `seo_pages.body_md` by `seo-pages.ts`. Split out from the
 * seed for the same reason `rules/lexicon.fixtures.ts` is split from
 * `rules/lexicon.ts`: the seed is a few dozen lines of upsert, the corpus is
 * a few thousand words of pt-BR prose, and mixing them makes both harder to
 * review.
 *
 * `seo-pages.ts` carries the rules about *what* may become a page. What
 * lives here is how each page is allowed to say it:
 *
 *  - **It describes a kind of line, never a company's conduct.** Several of
 *    these products are legitimately sold with the contracting step
 *    documented — CLAUDE.md §7.1.2 records a Claro-published billing
 *    authorisation contract for Ubook and a Vivo activation page for McAfee
 *    — and the pages that describe them say so plainly rather than leaving
 *    it out to sound sharper. `test/invariants/seo-content.spec.ts` proves
 *    no company name ever shares a sentence with an accusatory term.
 *  - **It never claims to know the reader's bill.** Every page's job is to
 *    let someone check whether *they* agreed to something; it never asserts
 *    they did not.
 *  - **PRD §14.2's pairs, and §14.1's voice.** "Para você verificar", never
 *    "cobrança ilegal"; "a norma prevê", never "você tem direito a
 *    receber". Short sentences, concrete numbers, no legal vocabulary
 *    (INV-004 via `lintUserFacingText`, no citation range granted anywhere).
 *
 * Every string is one paragraph on one source line. That is not a style
 * preference: `parseSeoContent` splits on blank lines, so a blank line
 * inside a field would round-trip as two blocks, and a field whose first
 * character is `#` would be read back as a heading. Both are limitations of
 * the Task 1 parser rather than of this corpus, and both are avoided here
 * rather than worked around.
 */

/** One row of `seo_pages`, before the issuer slug is resolved to an id. */
export type SeoPageSeed = {
  /** Must match an `issuers.slug` seeded by `issuers.ts`. */
  issuerSlug: string;
  /** The `[charge]` segment of the URL. Validated at module load. */
  chargeSlug: string;
  title: string;
  content: SeoPageContent;
};

// ---------------------------------------------------------------------------
// Issuers, as the pages speak of them
// ---------------------------------------------------------------------------

/**
 * How each seeded issuer is named in prose, and the bill section names its
 * pages are allowed to quote.
 *
 * The section names are a second copy of what `issuers.ts` seeds — the same
 * duplication `rules/lexicon.ts`'s `SVA_ANCHOR_SECTIONS` makes, for the same
 * reason (the seed's `SEED` is a module-private literal). Unlike that one,
 * this copy is checked: `test/seeds-seo.test.ts` asserts every name here is
 * present on the seeded `issuers` row, so a rename in `issuers.ts` breaks
 * the test instead of leaving a page quoting a section nobody has.
 *
 * `name` is the short form a person would say out loud, which is why Claro
 * is "Claro" and not the row's `displayName` "Claro Móvel". Both are covered
 * by the accusation invariant, which reads `displayName` *and* `aliases`.
 */
export const SEO_ISSUER_VOICES: Record<string, { name: string; sections: readonly string[] }> = {
  "claro-movel": { name: "Claro", sections: ["Aplicativos Digitais"] },
  "vivo-movel": {
    name: "Vivo",
    sections: [
      "Serviços Digitais",
      "Serviços Digitais avulsos",
      "Cobrança de Serviços de terceiros",
      "Adicionais Contratados",
    ],
  },
  "tim-movel": { name: "TIM", sections: ["Serviços de valor adicionado(SVA)"] },
  oi: { name: "Oi", sections: ["Serviços Digitais", "Outros Pacotes e Serviços Mensais"] },
  sky: { name: "Sky", sections: ["lançamentos diversos"] },
  algar: { name: "Algar", sections: ["Outros Valores", "SERVICOS FACILIDADES", "OUTRAS COBRANCAS"] },
};

function voice(issuerSlug: string): { name: string; sections: readonly string[] } {
  const found = SEO_ISSUER_VOICES[issuerSlug];
  if (found === undefined) throw new Error(`no issuer voice for ${JSON.stringify(issuerSlug)}`);
  return found;
}

/** `a seção “X”` / `as seções “X”, “Y” e “Z”`, so section names are always quoted verbatim. */
function sectionsPhrase(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length === 1) return `a seção ${quoted[0]!}`;
  const last = quoted[quoted.length - 1]!;
  return `as seções ${quoted.slice(0, -1).join(", ")} e ${last}`;
}

// ---------------------------------------------------------------------------
// Blocks every page shares
// ---------------------------------------------------------------------------

/**
 * CLAUDE.md §7.0, said to the reader in their own language and on every
 * single page: where this description came from, that it is not a statement
 * about any company, and that only their own record of agreeing to the
 * service answers the question for their bill.
 *
 * One constant rather than nineteen near-identical paragraphs, because the
 * disclosure losing a clause on one page is exactly the failure it exists to
 * prevent. It is the one block that is deliberately identical everywhere:
 * every page rests on the same four classes of source, and a page-specific
 * rewording of a disclosure is how a disclosure gets weaker on the page that
 * needed it most.
 *
 * All four of §7.0's source classes are named, not two. The TDATA page in
 * particular rests principally on the jus.com.br article, so a provenance
 * paragraph that said only "complaint reports and companies' own pages"
 * would understate its own sourcing on the page carrying the most weight.
 * "artigos jurídicos" is §7.0's own wording and cannot be used here —
 * "jurídico" is on PRD §14.3's forbidden list — so the clause says what
 * those articles are instead of what they are called.
 */
export const SEO_PROVENANCE =
  "Esta página foi montada a partir de relatos públicos de clientes, das páginas que as próprias empresas publicam sobre os seus serviços, de artigos e notícias que descrevem casos concretos e de um processo do Ministério Público sobre esse tipo de cobrança. Nenhuma fatura real foi lida para escrevê-la, e nomes de produto mudam com o tempo. Por isso ela descreve o que costuma aparecer, não o que está na sua conta: um serviço citado aqui não é uma afirmação de que alguma empresa fez algo errado. O único jeito de saber se a cobrança da sua fatura está certa é conferir se você contratou aquele serviço — e é isso que os passos acima ajudam a fazer.";

/**
 * The mechanism, told as a mechanism. Third-party billing is an ordinary,
 * openly-described commercial model, and a page that explained it as a trick
 * would be describing something other than what CLAUDE.md §7 found.
 */
function whyItAppears(issuerSlug: string, sectionText: string): SeoSection {
  const { name } = voice(issuerSlug);
  return {
    heading: "Por que ela aparece na conta",
    paragraphs: [
      "A conta da operadora reúne dois tipos de cobrança: o que você contratou dela — plano, ligações, dados — e o que você contratou de outras empresas através dela. O segundo grupo tem um nome no setor: serviço de valor adicionado, ou SVA. É conteúdo ou aplicativo de outra empresa, vendido pela operadora, com o valor somado à mesma fatura em vez de ir para o cartão.",
      `É um modelo de venda comum e antigo, e existe dos dois lados: a operadora entra com a base de clientes e com a cobrança, a outra empresa entra com o produto. Na ${name}, esse tipo de item aparece n${sectionText}. Isso importa na hora de conferir, porque o registro de que a assinatura foi contratada pode estar em qualquer um dos dois lados.`,
    ],
  };
}

/**
 * INV-002 in prose: every step here happens on the reader's own printed
 * bill or in the company's own channels. No credential is asked for, no
 * form is offered, and the page says so out loud — a page about unexpected
 * charges is exactly where someone would expect to be asked to "log in to
 * check", and being explicit about not doing that is part of the answer.
 */
function howToCheck(issuerSlug: string, sectionText: string): SeoSection {
  const { name } = voice(issuerSlug);
  return {
    heading: "Como conferir se você contratou",
    paragraphs: [
      `Comece pela fatura, no papel ou no PDF. Procure ${sectionText}: é onde a ${name} agrupa esse tipo de item. Anote três coisas: o texto exato do item como está escrito, o valor e há quantos ciclos ele aparece. São esses três dados que o atendimento vai pedir, e é com eles que a conversa fica curta.`,
      "Depois procure o registro da contratação. Ele costuma estar em dois lugares: na área de serviços e assinaturas do aplicativo ou do site da operadora, e no e-mail ou no SMS de confirmação enviado quando o serviço foi ativado. Quando quem presta o serviço é outra empresa, ela em geral também tem uma área de conta onde a assinatura aparece, com a data em que começou.",
      "Se você não encontrar esse registro, peça à operadora o histórico de contratação do item: a data, o canal usado e a forma como o aceite foi coletado. Peça junto o número de protocolo do atendimento e guarde-o com a data. É o protocolo que marca o começo dos prazos, e sem ele o passo seguinte volta para a estaca zero.",
      "Nada disso pede senha. Este site não pede login da sua operadora, não pede dado de cartão e não preenche formulário no seu lugar: a conferência inteira acontece na sua fatura e nos canais oficiais da empresa, com você no controle de cada passo.",
    ],
  };
}

/**
 * Norms only, and only the ones this repository already carries as data:
 * `TELECOM_PLAYBOOK_V1`'s `legalRefs` (Decreto 11.034/2022, CDC art. 42
 * parágrafo único, Res. Anatel 765/2023). Each is cited as what the rule
 * provides for, never as a verdict about a company or about the reader's
 * bill — which is also why the invariant spec grants no citation range: this
 * is the product's own voice describing a norm, not a quotation of one.
 */
function whatTheNormSays(): SeoSection {
  return {
    heading: "O que a norma prevê",
    paragraphs: [
      "As normas abaixo são as que aparecem citadas nesse tipo de discussão. Estão aqui como referência do que a regra prevê, não como avaliação da sua conta: nenhuma delas foi aplicada ao seu caso, porque esta página não conhece o seu caso.",
      "O Decreto 11.034/2022, que trata do atendimento ao consumidor, prevê no art. 13 e no seu §3º a suspensão da cobrança contestada enquanto o pedido é apurado, e no art. 12, §2º e §3º, limites de prazo para o atendimento responder. A Resolução Anatel 765/2023 prevê, nos arts. 60 a 62, a suspensão da cobrança questionada, e no art. 64 a devolução em dobro. O CDC prevê, no art. 42, parágrafo único, a devolução em dobro com correção, na hipótese que a própria norma descreve.",
      "Na prática, o caminho começa no atendimento da operadora, com protocolo. Se ele não resolver, o consumidor.gov.br e depois a Anatel são os canais seguintes, e os dois pedem o protocolo anterior. Nenhum prazo corre antes do primeiro registro, e por isso o passo mais útil continua sendo o mais simples: anotar o item, o valor e o protocolo.",
    ],
  };
}

/** Assembles a charge page from the two blocks that are its own and the two that are shared. */
function chargePage(input: {
  issuerSlug: string;
  chargeSlug: string;
  title: string;
  sectionText: string;
  intro: string;
  whatItIs: string[];
  faq: SeoPageContent["faq"];
}): SeoPageSeed {
  return {
    issuerSlug: input.issuerSlug,
    chargeSlug: input.chargeSlug,
    title: input.title,
    content: {
      intro: input.intro,
      sections: [
        { heading: "O que é essa linha", paragraphs: input.whatItIs },
        whyItAppears(input.issuerSlug, input.sectionText),
        howToCheck(input.issuerSlug, input.sectionText),
        whatTheNormSays(),
      ],
      faq: input.faq,
      provenance: SEO_PROVENANCE,
    },
  };
}

// ---------------------------------------------------------------------------
// The "what is an SVA section" page, one per seeded issuer
// ---------------------------------------------------------------------------

/**
 * The per-issuer paragraph of the "onde ele aparece" section.
 *
 * Claro, Vivo and Algar have a finding of their own in CLAUDE.md §7.1.1
 * (Claro's catalogue size and its streaming partnerships, Vivo's extra
 * section plus its combined package, the acronym appearing in an Algar
 * customer's own words). Oi and Sky have only the section name corroborated,
 * and their notes say exactly that instead of padding themselves out — a
 * page claiming to list items it does not have would be the §7.0 ceiling
 * being crossed for the sake of word count.
 *
 * **TIM is neither.** This note used to say the research had confirmed no
 * item list at TIM, which the corpus itself contradicted: §7.1.2's Ubook row
 * is ✅ confirmed at TIM under the operator's own "TIM Livros" branding, and
 * `tim-movel/ubook` ships. A reader on the TIM page was being told there was
 * nothing to name while the one confirmed thing sat a click away. The note
 * names it.
 */
const SVA_ISSUER_NOTE: Record<string, string> = {
  "claro-movel":
    "O catálogo de serviços digitais da Claro passou de mais de cem produtos para cerca de sessenta, em boa parte parcerias de streaming — nomes como YouTube, Netflix, Prime Video, HBO e Telecine Play. Isso ajuda a calibrar a leitura: boa parte do que aparece nessa seção é produto de parceiro conhecido, vendido de forma aberta, e a pergunta que sobra é sempre a mesma, se aquela assinatura em particular foi contratada por você.",
  "vivo-movel":
    "A Vivo usa mais de um nome de seção para esse tipo de item, e itens somados podem aparecer sob um pacote com nome próprio em vez de linha a linha. Quando o valor de uma linha for alto demais para uma assinatura só, o primeiro pedido ao atendimento é o detalhamento: quais itens estão dentro e quanto custa cada um.",
  "tim-movel":
    "A TIM usa a sigla no próprio nome da seção, o que facilita a busca: a expressão “serviços de valor adicionado” impressa na fatura já indica o bloco a conferir. Entre os itens que podem aparecer aí, a pesquisa que originou este site confirmou um: o serviço de audiolivros Ubook, vendido na TIM com a marca TIM Livros, que tem página própria neste site. Fora ele, o que está descrito aqui é o mecanismo, e não um catálogo fechado.",
  oi: "A Oi usa mais de um nome de seção para esse tipo de item, então vale olhar as duas antes de concluir que não há nada a conferir. A pesquisa que originou este site não confirmou uma lista de itens cobrados nessas seções na Oi — o que está descrito aqui é o mecanismo, não um catálogo.",
  sky: "A pesquisa que originou este site não confirmou nenhum item específico cobrado nessa seção na Sky. O que está descrito aqui é o mecanismo, não uma lista: se houver uma linha que você não reconhece, o caminho de conferência abaixo é o mesmo, e a seção é o lugar por onde começar.",
  // §7.1.1's Algar row evidences the acronym in the title of a *customer's*
  // complaint, not in Algar's support vocabulary — so the note says the
  // acronym is how people describe this kind of charge, and drops the
  // "tende a encurtar a conversa" advice, which had no source behind it.
  algar:
    "Na Algar, a sigla SVA aparece nos relatos de clientes que descrevem esse tipo de cobrança, ainda que os nomes de seção impressos na fatura sejam outros. A operadora usa mais de um nome de seção para esse tipo de item, e vale olhar todas antes de concluir que não há nada a conferir.",
};

/**
 * The FAQ of each "what is an SVA section" page, per issuer.
 *
 * These used to be one shared array of three questions, which meant six URLs
 * emitting a byte-identical JSON-LD `FAQPage`. PRD §18's gate for this block
 * is "Rich results válidos", and six identical FAQ payloads across six URLs
 * is the shape that gets a rich result dropped — the duplication is not a
 * style problem here, it is the acceptance criterion.
 *
 * Each is grounded in what §7 confirms about *that* issuer and nothing else:
 * its own section names (§20.1/§7.1.1), its own §7.1.1 finding if it has
 * one, and whether this corpus actually has an item page to point at. Where
 * an issuer honestly has less to say the FAQ is shorter — Oi, Sky and Algar
 * get two questions, because a third would have to be invented, and an
 * invented question is worse than a short page.
 *
 * The other three shared blocks were left alone, deliberately:
 *
 *  - `whatTheNormSays` is byte-identical on all nineteen pages and stays
 *    that way. Anatel Res. 765/2023 and CDC art. 42 do not say a different
 *    thing on the Sky page than on the Vivo page, and rewording a norm six
 *    ways to look different to a crawler is how a norm gets misstated.
 *  - `whyItAppears` and `howToCheck` already vary by issuer name and by
 *    section name, which is exactly where the issuers' facts actually
 *    differ. They repeat within one issuer's pages (all nine Vivo item pages
 *    share them), and that is the same mechanism explained the same way to
 *    someone who landed on a different item — not a claim that differs.
 *  - `SEO_PROVENANCE` is identical everywhere on purpose; see its own note.
 */
const SVA_ISSUER_FAQ: Record<string, SeoPageContent["faq"]> = {
  "claro-movel": [
    {
      question: "O que costuma estar na seção “Aplicativos Digitais”?",
      answer:
        "Em boa parte, parcerias de streaming e de conteúdo vendidas pela operadora — o catálogo de serviços digitais da Claro passou de mais de cem produtos para cerca de sessenta, com nomes conhecidos entre eles. São produtos vendidos de forma aberta, e a pergunta que sobra é sempre a mesma: se aquela assinatura em particular foi contratada por você.",
    },
    {
      question: "Algum item dessa seção tem página própria neste site?",
      answer:
        "Sim, um: o Ubook, serviço de audiolivros por assinatura. Os outros itens que podem aparecer aí não entraram neste site porque a pesquisa que o originou não os confirmou na Claro, e não porque não existam.",
    },
    {
      question: "O item é de uma marca que eu conheço. Ainda vale conferir?",
      answer:
        "Vale, e por um motivo simples: o que a conferência responde não é se o produto é bom, e sim se a assinatura foi contratada, quando e por qual canal. Uma marca conhecida não muda nenhuma dessas três respostas.",
    },
  ],
  "vivo-movel": [
    {
      question: "A Vivo usa mais de um nome de seção. Preciso olhar todas?",
      answer:
        "Sim. Esse tipo de item pode aparecer em “Serviços Digitais”, em “Serviços Digitais avulsos”, em “Cobrança de Serviços de terceiros” ou em “Adicionais Contratados”, e olhar só uma delas costuma deixar item para trás. Faça a lista com o texto exato e o valor de cada linha antes de ligar.",
    },
    {
      question: "Uma linha só pode estar somando várias assinaturas?",
      answer:
        "Pode. Existe um agrupamento chamado “Serviços Digitais III” que aparece com o valor de vários itens somados em uma linha só. Se o valor de uma linha for alto demais para uma assinatura sozinha, o primeiro pedido ao atendimento é o detalhamento: quais itens estão dentro e quanto custa cada um.",
    },
    {
      question: "Quais itens dessa parte da conta têm página própria neste site?",
      answer:
        "Skeelo, GoRead, Hube Jornais, NBA Básico, Clube de Revistas, FunKids, McAfee, Vivo Meditação Lite e os itens escritos como “Serviços de Terceiro TDATA”. São os que a pesquisa que originou este site confirmou na Vivo; a seção pode conter outros.",
    },
  ],
  "tim-movel": [
    {
      question: "Por que a sigla já está no nome da seção?",
      answer:
        "Porque a TIM nomeia o bloco pela categoria: a expressão “serviços de valor adicionado” impressa na fatura já é o próprio bloco a conferir. Isso facilita a busca no papel ou no PDF, mas não diz nada sobre uma linha específica dentro dele.",
    },
    {
      question: "Que item já se sabe que aparece nessa seção na TIM?",
      answer:
        "O serviço de audiolivros Ubook, vendido na TIM com a marca TIM Livros, que tem página própria neste site. É o único que a pesquisa que originou este site confirmou na TIM, o que não quer dizer que seja o único que existe.",
    },
    {
      question: "O nome na fatura pode ser diferente do nome do aplicativo?",
      answer:
        "Pode, e nessa seção é comum: o mesmo serviço costuma ser vendido em cada operadora com uma marca própria. Ao falar com o atendimento, cite as duas coisas, o texto exato da fatura e o nome do aplicativo instalado no aparelho.",
    },
  ],
  oi: [
    {
      question: "São dois nomes de seção. Preciso olhar os dois?",
      answer:
        "Sim: esse tipo de item pode estar em “Serviços Digitais” ou em “Outros Pacotes e Serviços Mensais”, e o mesmo tipo de assinatura pode cair em qualquer um dos dois. Olhe os dois antes de concluir que não há nada a conferir.",
    },
    {
      question: "Não reconheço o nome de nenhuma linha. Por onde começo?",
      answer:
        "Pelo texto, não pelo valor. Copie o texto exato do item, anote o valor e conte há quantos ciclos ele aparece, comparando as faturas anteriores. Com esses três dados o pedido ao atendimento fica objetivo, mesmo sem saber de antemão que serviço é.",
    },
  ],
  sky: [
    {
      question: "“lançamentos diversos” quer dizer o quê?",
      answer:
        "É um nome de seção genérico: ele descreve onde a cobrança foi lançada, não o que foi contratado. Por isso a leitura útil é linha a linha, cada uma com o seu texto e o seu valor, e não pelo total da seção.",
    },
    {
      question: "Este site tem página para algum item cobrado na Sky?",
      answer:
        "Não. A pesquisa que originou este site corroborou o nome dessa seção e nenhum item dentro dela, então o que está aqui é o mecanismo e o caminho de conferência. Isso não quer dizer que a seção esteja vazia na sua conta.",
    },
  ],
  algar: [
    {
      question: "São três nomes de seção. Por onde eu começo?",
      answer:
        "Comece por “Outros Valores”, “SERVICOS FACILIDADES” e “OUTRAS COBRANCAS” — os três agrupam cobrança que não é do plano em si. Percorra os três e monte uma lista única, com o texto exato e o valor de cada linha, antes de falar com o atendimento.",
    },
    {
      question: "Posso usar a sigla SVA ao falar com o atendimento?",
      answer:
        "A sigla é como muita gente descreve esse tipo de cobrança, então ela costuma ser entendida. Ainda assim, o que identifica a linha é o texto exato impresso na fatura: leve os dois, a sigla para explicar o assunto e o texto para localizar o item.",
    },
  ],
};

function svaSectionPage(issuerSlug: string): SeoPageSeed {
  const { name, sections } = voice(issuerSlug);
  const sectionText = sectionsPhrase(sections);
  const note = SVA_ISSUER_NOTE[issuerSlug];
  if (note === undefined) throw new Error(`no SVA note for ${JSON.stringify(issuerSlug)}`);
  const faq = SVA_ISSUER_FAQ[issuerSlug];
  if (faq === undefined) throw new Error(`no SVA faq for ${JSON.stringify(issuerSlug)}`);

  return {
    issuerSlug,
    chargeSlug: "servicos-de-valor-adicionado",
    title: `Serviços de valor adicionado (SVA) na conta da ${name}: o que são`,
    content: {
      intro: `Serviço de valor adicionado, ou SVA, é o nome que o setor usa para conteúdo e aplicativos de outras empresas vendidos pela operadora e cobrados na mesma conta. Na ${name}, esse tipo de item aparece n${sectionText}. Esta página explica o que essa parte da fatura agrupa e como conferir cada linha dela.`,
      sections: [
        {
          heading: "O que é um serviço de valor adicionado",
          paragraphs: [
            "Serviço de valor adicionado é uma cobrança que não faz parte do serviço de telecomunicação em si. O plano é uma coisa: ligações, dados, mensagens. O SVA é outra: um aplicativo, um catálogo de conteúdo, um antivírus. É produto de outra empresa, vendido através da operadora e somado à mesma fatura.",
            "A sigla aparece na fatura e no vocabulário do atendimento, então vale reconhecê-la. Ela não diz nada sobre a cobrança estar certa ou errada: descreve só a natureza do item, algo contratado por fora do plano, com data de contratação e cancelamento próprios.",
          ],
        },
        {
          heading: `Onde ele aparece na conta da ${name}`,
          paragraphs: [
            // The idiomatic phrase for "the best place to start" cannot be
            // used here: it collides with INV-006's political-affiliation
            // stem, which `test/invariants/sensitive.spec.ts` matches over
            // every line of every seed source file — comments included, which
            // is why this note cannot name the word either. Narrowing that
            // vocabulary to let a nicer phrase through is not a trade this
            // corpus gets to make.
            `Na ${name}, esse tipo de item fica n${sectionText}. O nome da seção é o melhor lugar para começar: em vez de ler a conta inteira, vá direto até essa parte da fatura e trate as linhas uma por uma, cada uma com o seu texto e o seu valor.`,
            note,
          ],
        },
        howToCheck(issuerSlug, sectionText),
        whatTheNormSays(),
      ],
      faq,
      provenance: SEO_PROVENANCE,
    },
  };
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

const VIVO_DIGITAIS = sectionsPhrase(["Serviços Digitais"]);
const VIVO_TERCEIROS = sectionsPhrase(["Cobrança de Serviços de terceiros"]);
const CLARO_APPS = sectionsPhrase(["Aplicativos Digitais"]);
const TIM_SVA = sectionsPhrase(["Serviços de valor adicionado(SVA)"]);

export const SEO_PAGES: readonly SeoPageSeed[] = [
  // --- CLAUDE.md §7.1.2, observed at Vivo -------------------------------
  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "skeelo",
    title: "Skeelo na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "Skeelo é um serviço de audiolivros e leitura por assinatura que pode ser cobrado dentro da conta da Vivo, na parte da fatura reservada aos serviços digitais. Esta página explica o que costuma ser essa linha, por que ela aparece junto da conta de celular e como conferir, na sua própria fatura, se a assinatura foi contratada.",
    whatItIs: [
      "A Skeelo é uma empresa brasileira de audiolivros e livros digitais que vende assinatura através de operadoras: em vez de cobrar no cartão, o valor entra na conta do telefone. Nos relatos públicos que deram origem a esta página, o item aparece na fatura da Vivo e também na de um provedor regional, a Brisanet, sempre como serviço contratado através da operadora.",
      "O texto muda de linha para linha. Os relatos trazem, entre outras, as formas Skeelo Top, Skeelo Promo, Skeelo Premium, Skeelo Intermediário e Skeelo Audiobooks: planos diferentes do mesmo serviço, com valores diferentes. Qual deles está na sua conta só o texto exato do item na fatura responde.",
    ],
    faq: [
      {
        question: "Dá para cancelar o Skeelo sem mexer no meu plano?",
        answer:
          "Sim: é uma assinatura separada do plano de celular. O cancelamento pode ser pedido nos canais de atendimento da operadora e, em geral, também na área de conta do próprio serviço. Peça o número de protocolo e guarde a data — é ela que marca a partir de quando o item não deveria mais entrar na fatura.",
      },
      {
        question: "O item continuou aparecendo depois que eu cancelei. O que fazer?",
        answer:
          "Anote o protocolo do cancelamento, a data e os ciclos em que o item voltou. Com esses três dados o pedido fica objetivo: um item, um valor, uma data. Se o atendimento não resolver no prazo, o consumidor.gov.br e a Anatel são os canais seguintes, e os dois pedem o protocolo anterior.",
      },
      {
        question: "Skeelo Promo e Skeelo Top são a mesma coisa?",
        answer:
          "São nomes de planos diferentes do mesmo serviço, e cada um tem o seu valor. Na hora de falar com o atendimento, use o texto exato que está na sua fatura, sem abreviar: é assim que o item é localizado no sistema da operadora.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "goread",
    title: "GoRead na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "GoRead é um serviço de leitura de revistas e livros digitais que pode ser cobrado dentro da conta da Vivo, na parte da fatura reservada aos serviços digitais. Esta página explica o que costuma ser essa linha e como conferir, na sua fatura, se a assinatura foi contratada.",
    whatItIs: [
      "O GoRead dá acesso a revistas e livros digitais por assinatura mensal, e está ligado à Editora Abril, que publica parte do catálogo. Como as outras assinaturas vendidas através da operadora, o valor entra na conta do celular em vez de ir para o cartão.",
      "O nome aparece escrito de duas formas nos relatos, junto e separado: GoRead e Go Read. As duas são o mesmo serviço. Vale copiar o texto exato como está na sua conta, porque é por ele que o atendimento localiza o item.",
    ],
    faq: [
      {
        question: "Onde eu cancelo: na operadora ou no próprio serviço?",
        answer:
          "Os dois caminhos existem. Pelo atendimento da operadora, o pedido trata da cobrança que está na conta; pela área de conta do próprio serviço, trata da assinatura na origem. Em qualquer um dos dois, peça o protocolo ou o comprovante e guarde a data.",
      },
      {
        question: "Tenho o GoRead e outros itens parecidos na mesma seção. Preciso tratar um por um?",
        answer:
          "Sim, um por um. Cada assinatura tem a sua data de contratação, o seu valor e o seu cancelamento, e tratar tudo como um bloco só costuma deixar um item para trás. Faça uma lista com o texto exato de cada linha e o valor de cada uma antes de ligar.",
      },
      {
        question: "O valor mudou de um mês para o outro. Isso é normal?",
        answer:
          "Pode ser: assinaturas têm reajuste, e há campanhas com valor menor nos primeiros meses. O que dá para fazer é comparar a fatura atual com a anterior e anotar em que ciclo a diferença apareceu — com as duas em mãos, a pergunta ao atendimento fica concreta.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "hube-jornais",
    title: "Hube Jornais na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "Hube Jornais é um agregador de jornais digitais que pode ser cobrado dentro da conta da Vivo, na parte da fatura reservada aos serviços digitais. Esta página explica o que costuma ser essa linha e como conferir, na sua fatura, se a assinatura foi contratada.",
    whatItIs: [
      "Um agregador de jornais reúne várias publicações em um único aplicativo e cobra uma assinatura só pelo conjunto. É esse tipo de produto que o Hube Jornais oferece, vendido através da operadora e cobrado junto da conta de celular.",
      "Nos relatos o nome aparece no singular e no plural, Hube Jornais e Hube Jornal, e é o mesmo serviço. Ele costuma dividir a seção com outras assinaturas de leitura, o que deixa várias linhas parecidas lado a lado na mesma fatura: vale conferir uma de cada vez, com o texto exato de cada uma.",
    ],
    faq: [
      {
        question: "É a mesma coisa que assinar um jornal?",
        answer:
          "Não exatamente. O agregador dá acesso a um conjunto de publicações dentro de um aplicativo, e a assinatura é do conjunto. Uma assinatura feita direto com um jornal é outra relação, com outra cobrança e outro cancelamento.",
      },
      {
        question: "Como eu descubro desde quando estou pagando?",
        answer:
          "Compare as faturas dos últimos meses e procure o primeiro ciclo em que a linha aparece. Se você não tiver os PDFs guardados, a operadora pode informar a data de ativação do serviço — peça junto o número de protocolo do atendimento.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "nba-basico",
    title: "NBA Básico na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "NBA Básico é um pacote de conteúdo esportivo vendido pela Vivo em parceria com a NBA e cobrado dentro da conta, na parte da fatura reservada aos serviços digitais. Esta página explica o que costuma ser essa linha e como conferir a sua.",
    whatItIs: [
      "É um pacote de acesso a conteúdo da liga de basquete, no modelo de assinatura mensal, oferecido pela operadora como item adicional ao plano. A palavra “Básico” descreve o nível do pacote contratado, e faz parte do texto que a fatura usa.",
      "Assinaturas de conteúdo esportivo costumam ser vendidas em campanhas de temporada, com um período promocional e renovação automática depois. Se a linha apareceu de repente na sua conta, as duas informações úteis a pedir são a data em que ela começou e o canal em que a contratação foi feita.",
    ],
    faq: [
      {
        question: "Eu assinei durante uma promoção. O valor pode ter mudado?",
        answer:
          "Pode: é comum haver um período com valor promocional e renovação pelo valor cheio depois. Compare as últimas faturas, anote em que ciclo o valor mudou e leve essa data ao atendimento junto com o texto exato do item.",
      },
      {
        question: "Cancelar o pacote afeta o meu plano de dados?",
        answer:
          "Não: é uma assinatura à parte, com o seu próprio valor na fatura. Ainda assim, peça o protocolo do cancelamento e confira a fatura seguinte, que é onde dá para ver se o item saiu.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "clube-de-revistas",
    title: "Clube de Revistas na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "Clube de Revistas é uma assinatura de revistas digitais que pode ser cobrada dentro da conta da Vivo, na parte da fatura reservada aos serviços digitais. Esta página explica o que costuma ser essa linha e como conferir a sua.",
    whatItIs: [
      "É um pacote de acesso a revistas por assinatura mensal, vendido através da operadora e cobrado junto da conta de celular. Nos relatos que deram origem a esta página, o valor citado é de R$ 19,90 por mês, com renovação automática.",
      "Renovação automática quer dizer que a assinatura continua até alguém pedir para parar: ela não vence sozinha no fim de um período. É por isso que uma assinatura feita há bastante tempo pode seguir na fatura sem nenhuma outra ação depois da contratação.",
    ],
    faq: [
      {
        question: "O valor na minha conta é diferente de R$ 19,90. É o mesmo serviço?",
        answer:
          "Pode ser. O valor citado nos relatos é de um período específico, e preços mudam com reajuste e campanha. O que identifica o item é o texto na fatura, não o valor — use o texto exato ao falar com o atendimento.",
      },
      {
        question: "Dá para desligar a renovação automática sem cancelar tudo?",
        answer:
          "Essa é uma pergunta para o atendimento da operadora ou para a área de conta do serviço, porque depende de como o produto é oferecido. Ao perguntar, peça a resposta com número de protocolo: assim fica registrado o que foi dito e quando.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "funkids",
    title: "FunKids na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "FunKids é um serviço de conteúdo infantil que pode ser cobrado dentro da conta da Vivo, na parte da fatura reservada aos serviços digitais. Esta página explica o que costuma ser essa linha e como conferir a sua.",
    whatItIs: [
      // §7.1.2's FunKids row evidences "página própria da empresa no RA" —
      // a profile on a complaints platform, which is not the same thing as a
      // support channel the company runs. The earlier wording inferred one;
      // this says only that two cancellation paths are worth asking about.
      "É uma assinatura de conteúdo para crianças, vendida através da operadora e cobrada junto da conta de celular. Como em todo serviço vendido dessa forma, o cancelamento pode ter dois caminhos, o da operadora e o da empresa que presta o serviço, e vale perguntar ao atendimento qual dos dois vale para o seu caso.",
      "Serviços infantis costumam ser contratados a partir do próprio aparelho, às vezes em poucos toques dentro de um aplicativo ou de uma página de campanha. Se a linha apareceu e ninguém em casa lembra de ter assinado, a pergunta útil ao atendimento é a data e o canal da contratação.",
    ],
    faq: [
      {
        question: "Meu filho pode ter assinado pelo celular?",
        answer:
          "É uma possibilidade que vale checar, porque parte dessas assinaturas é contratada a partir do próprio aparelho. Peça à operadora a data e o canal da contratação: com essa informação você sabe de onde partiu, e o pedido seguinte fica mais direto.",
      },
      {
        question: "Como eu evito que aconteça de novo?",
        answer:
          "Vale perguntar ao atendimento se a sua linha aceita bloqueio de contratação de serviços adicionais. É um pedido separado do cancelamento do item que já está na conta, e também gera número de protocolo — anote os dois, com as datas.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "mcafee",
    title: "McAfee na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "McAfee é um antivírus vendido pela Vivo como serviço adicional, com página própria de ativação na operadora, e pode aparecer na fatura na parte reservada aos serviços digitais. Esta página explica o que é essa linha e como conferir a sua.",
    whatItIs: [
      "É uma assinatura de segurança para computador e celular, com defesa contra vírus e, conforme o pacote, um serviço de conexão protegida. A Vivo mantém uma página própria para ativar o serviço, o que significa que a contratação tem canal oficial e documentado: é um produto vendido de forma aberta, não um item obscuro por natureza.",
      "Nos relatos, o item aparece com nomes como McAfee Proteção e McAfee Safe Connect. O que muda de caso para caso é a data em que a assinatura começou e se um cancelamento pedido chegou a ser processado — e isso a fatura sozinha não conta, é preciso perguntar.",
    ],
    faq: [
      {
        question: "Eu já tenho antivírus. Preciso desse também?",
        answer:
          "Essa decisão é sua, e esta página não opina sobre produto. O que dá para fazer aqui é objetivo: descobrir desde quando o item está na conta, quanto ele custa por mês e como cancelar, se for essa a sua escolha.",
      },
      {
        question: "Onde fica o registro de que eu ativei o serviço?",
        answer:
          "A ativação tem canal oficial na operadora, e costuma deixar rastro no e-mail ou no SMS de confirmação e na área de serviços contratados do aplicativo. Se você não encontrar, peça ao atendimento a data e o canal da ativação, com número de protocolo.",
      },
      {
        question: "Cancelei e o item voltou no mês seguinte. Isso acontece?",
        answer:
          "Pedidos feitos perto do fechamento do ciclo às vezes só se refletem na fatura seguinte. Vale conferir duas faturas depois do pedido antes de concluir, e guardar o protocolo do cancelamento com a data: é ele que sustenta um pedido de correção, se for necessário.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "vivo-meditacao-lite",
    title: "Vivo Meditação Lite na conta da Vivo: o que é essa linha",
    sectionText: VIVO_DIGITAIS,
    intro:
      "Vivo Meditação Lite é um aplicativo de bem-estar com a marca da operadora, cobrado como assinatura mensal dentro da conta, na parte da fatura reservada aos serviços digitais. Esta página explica o que é essa linha e como conferir a sua.",
    whatItIs: [
      "É um serviço de conteúdo de relaxamento e sono, com faixas de áudio e exercícios guiados, no modelo de assinatura mensal. Nos relatos, o valor citado é de R$ 2,49 por mês, o que o coloca entre os itens de menor valor da seção.",
      "Valor baixo é justamente o que faz uma linha dessas atravessar muitos ciclos sem ser notada. A conferência é a mesma de qualquer outra assinatura, e vale a pena mesmo por poucos reais: some o valor pelos meses em que ele aparece antes de decidir se compensa o telefonema.",
    ],
    faq: [
      {
        question: "Vale a pena tratar de uma cobrança de R$ 2,49?",
        answer:
          "Depende de há quantos ciclos ela aparece. Multiplique o valor pelo número de meses em que ele está na fatura e compare com o tempo que você gastaria: é uma conta de dois minutos, e ela responde melhor do que qualquer regra geral.",
      },
      {
        question: "O aplicativo é da operadora ou de outra empresa?",
        answer:
          "O produto leva a marca da própria operadora. Isso não muda o caminho da conferência: a data da contratação, o canal e o número de protocolo continuam sendo as três coisas a pedir.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "tdata",
    title: "Serviços de Terceiro TDATA na conta da Vivo: o que é essa linha",
    sectionText: VIVO_TERCEIROS,
    intro:
      "TDATA é a sigla de Telefônica Data S.A., empresa do mesmo grupo da Vivo, e aparece na fatura em itens escritos como “Serviços de Terceiro TDATA” ou “Cobrança Serviços de Terceiro TDATA”. Esta página explica o que esse rótulo agrupa, por que ele não diz sozinho qual serviço foi prestado, e o que pedir para descobrir.",
    whatItIs: [
      "O texto do item é um rótulo de agrupamento, não a descrição de um produto. Sob ele já foram registrados serviços bem diferentes entre si, de antivírus a manutenção estendida de linha fixa: o que os une é a forma de cobrança, não o que foi contratado.",
      "Por isso, nessa linha mais do que em qualquer outra, o passo que resolve é pedir o detalhamento — qual serviço específico está dentro do item, desde quando, e por qual canal foi contratado. Sem esse detalhamento não dá para dizer se a linha faz sentido para você, porque o nome sozinho não carrega essa informação.",
      "Vale saber também de quem se trata: TDATA é a Telefônica Data S.A., empresa do mesmo grupo da operadora. A palavra “terceiro” no texto do item descreve a forma da cobrança, e não necessariamente uma empresa de fora do grupo.",
    ],
    faq: [
      {
        question: "O que exatamente está sendo cobrado nesse item?",
        answer:
          "O texto da fatura não responde a isso sozinho: ele nomeia a forma de cobrança, não o produto. Peça ao atendimento o detalhamento do item — qual serviço, desde quando e por qual canal foi contratado — e anote o número de protocolo do pedido.",
      },
      {
        question: "“Terceiro” quer dizer outra empresa?",
        answer:
          "Nem sempre. TDATA é a Telefônica Data S.A., do mesmo grupo da operadora. O termo descreve o tipo de cobrança que aparece na fatura, e não necessariamente uma empresa de fora.",
      },
      {
        question: "Vi o item com textos diferentes em meses diferentes. É a mesma coisa?",
        answer:
          "Pode ser o mesmo agrupamento com redação diferente, ou serviços diferentes sob o mesmo rótulo. É mais um motivo para pedir o detalhamento: com ele, cada ciclo passa a ter um nome de serviço, e a comparação entre meses fica possível.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "vivo-movel",
    chargeSlug: "servicos-digitais-iii",
    title: "Serviços Digitais III na conta da Vivo: o que é esse pacote",
    sectionText: VIVO_DIGITAIS,
    intro:
      "Serviços Digitais III é o nome de um pacote que aparece na conta da Vivo somando várias assinaturas em uma linha só. Esta página explica o que esse agrupamento significa e como descobrir quais itens estão dentro dele.",
    whatItIs: [
      "Não é um serviço: é um agrupamento de cobrança. Em vez de uma linha por assinatura, a fatura traz uma linha com o valor somado de várias, e o nome do pacote não diz quais. Nos relatos, itens como FunKids, Hube Jornais e Vivo Meditação Lite aparecem somados sob esse rótulo.",
      "A consequência prática é direta: um valor que parece ser de uma assinatura só pode ser de três ou quatro. Antes de decidir qualquer coisa, peça o detalhamento do pacote — o nome de cada item dentro dele, o valor de cada um e a data em que cada um começou.",
    ],
    faq: [
      {
        question: "Como eu descubro o que está dentro do pacote?",
        answer:
          "Pedindo o detalhamento ao atendimento da operadora: o nome de cada item, o valor individual e a data de contratação de cada um. Peça o número de protocolo do pedido, que é o que marca a data em que a informação foi solicitada.",
      },
      {
        question: "Dá para cancelar só um item do pacote?",
        answer:
          "Essa é a pergunta a fazer com o detalhamento em mãos, porque a resposta depende de como cada item foi contratado. Com a lista de itens e valores, o pedido deixa de ser “cancelar o pacote” e passa a ser “cancelar este item, de tal valor”.",
      },
      {
        question: "O número III quer dizer que existem outros pacotes?",
        answer:
          "O que vale para o atendimento é o texto da fatura, com numeral e tudo. Copie-o exatamente como está na sua conta em vez de descrevê-lo: é assim que o item é localizado no sistema.",
      },
    ],
  }),

  // --- CLAUDE.md §7.1.1, Vivo's third-party section as its own page -----
  {
    issuerSlug: "vivo-movel",
    chargeSlug: "cobranca-de-servicos-de-terceiros",
    title: "Cobrança de Serviços de Terceiros na conta da Vivo: o que é essa seção",
    content: {
      intro:
        "“Cobrança de Serviços de terceiros” é o nome de uma seção da fatura da Vivo, e não de um serviço. Esta página explica o que essa seção agrupa, por que ela existe e como ler o que está dentro dela.",
      sections: [
        {
          heading: "O que é essa seção",
          paragraphs: [
            "A seção reúne itens que a operadora cobra em nome de outras empresas, ou de empresas do mesmo grupo. É um bloco de faturamento: o que define um item como pertencente a ele é a forma de cobrança, não o tipo de produto. Por isso serviços muito diferentes entre si podem aparecer lado a lado.",
            "Ler essa seção é diferente de ler o resto da conta. No plano, o que você contratou tem nome óbvio; aqui, cada linha pode ser de uma empresa diferente, com data de contratação, canal e cancelamento próprios. A leitura útil é linha a linha, e não pelo total da seção.",
          ],
        },
        whyItAppears("vivo-movel", VIVO_TERCEIROS),
        howToCheck("vivo-movel", VIVO_TERCEIROS),
        whatTheNormSays(),
      ],
      faq: [
        {
          question: "“Terceiros” quer dizer que a operadora não tem nada a ver com a cobrança?",
          answer:
            "Não. A cobrança está na fatura da operadora, e o atendimento dela é o primeiro canal para tratar do assunto, inclusive para pedir o detalhamento de um item. Em alguns casos a empresa por trás da linha é do mesmo grupo econômico.",
        },
        {
          question: "Por onde eu começo se tem várias linhas nessa seção?",
          answer:
            "Pela lista. Copie o texto exato e o valor de cada linha, e some. Com a lista pronta, você trata um item por vez, e cada um vira um pedido com o seu próprio número de protocolo.",
        },
        {
          question: "Essa seção pode aparecer com outro nome?",
          answer:
            "O nome da seção varia entre operadoras e entre versões da fatura. O que não varia é a função: agrupar cobranças feitas em nome de outras empresas. Se o nome na sua conta for diferente, procure a parte que reúne serviços digitais e assinaturas.",
        },
      ],
      provenance: SEO_PROVENANCE,
    },
  },

  // --- CLAUDE.md §7.1.2, Ubook, confirmed at two issuers ----------------
  chargePage({
    issuerSlug: "claro-movel",
    chargeSlug: "ubook",
    title: "Ubook na conta da Claro: o que é essa linha",
    sectionText: CLARO_APPS,
    intro:
      "Ubook é um serviço de audiolivros vendido através de operadoras, e pode ser cobrado dentro da conta da Claro, na parte da fatura reservada aos aplicativos digitais. Esta página explica o que é essa linha, incluindo o que já se sabe sobre como a contratação é registrada, e como conferir a sua.",
    whatItIs: [
      "O Ubook é um catálogo de audiolivros por assinatura mensal. Na Claro, ele é vendido com um contrato de autorização de cobrança publicado pela própria operadora: existe um documento público descrevendo como o cliente autoriza que o valor entre na conta. Isso vale dizer com todas as letras — é um produto vendido de forma aberta, com o aceite documentado, e não uma linha misteriosa por natureza.",
      "O que isso não responde é a sua fatura em particular. Um produto vendido corretamente ainda pode estar na conta de alguém que não lembra de ter assinado, ou seguir sendo cobrado depois de um cancelamento que não foi processado. É isso que os passos abaixo ajudam a verificar, e a resposta pode perfeitamente ser “sim, fui eu que assinei”.",
    ],
    faq: [
      {
        question: "Existe registro de como a contratação foi autorizada?",
        answer:
          "Na Claro há um contrato de autorização de cobrança publicado pela operadora, descrevendo o modelo. Para a sua linha em particular, peça ao atendimento a data e o canal em que a autorização foi coletada, com número de protocolo.",
      },
      {
        question: "Ubook e Ubook Jornais são a mesma assinatura?",
        answer:
          "São produtos do mesmo serviço com escopos diferentes, e cada um aparece com o seu texto na fatura. Copie o texto exato da sua conta antes de ligar: é ele que identifica o item.",
      },
      {
        question: "Eu cancelei e a cobrança continuou. Isso muda alguma coisa?",
        answer:
          "Muda o que você precisa levar ao atendimento: o protocolo do cancelamento, a data e os ciclos em que o item voltou a aparecer. Um pedido com essas três informações é objetivo e não depende da memória de ninguém.",
      },
    ],
  }),

  chargePage({
    issuerSlug: "tim-movel",
    chargeSlug: "ubook",
    title: "Ubook, ou TIM Livros, na conta da TIM: o que é essa linha",
    sectionText: TIM_SVA,
    intro:
      "Na TIM, o serviço de audiolivros Ubook é oferecido com a marca TIM Livros, e a cobrança pode aparecer na conta dentro da seção de serviços de valor adicionado. Esta página explica o que é essa linha e como conferir, na sua fatura, se a assinatura foi contratada.",
    whatItIs: [
      "É o mesmo catálogo de audiolivros por assinatura mensal vendido em outras operadoras sob o nome Ubook. Na TIM ele aparece com a marca da própria operadora, TIM Livros, e essa costuma ser a razão de o nome na fatura não bater com o nome do aplicativo instalado no celular.",
      "Isso também explica por que buscar pelo nome do aplicativo às vezes não leva a lugar nenhum: a linha da fatura usa a marca da operadora. Ao falar com o atendimento, cite as duas coisas — o texto exato da fatura e o nome do aplicativo que está no aparelho.",
    ],
    faq: [
      {
        question: "Por que o nome na fatura é diferente do nome do aplicativo?",
        answer:
          "Porque o mesmo serviço é vendido em cada operadora com uma marca própria. Na TIM, a marca é TIM Livros. Não é uma cobrança diferente: é o mesmo produto com outro rótulo na conta.",
      },
      {
        question: "Onde fica registrada a contratação?",
        answer:
          "Na área de serviços e assinaturas do aplicativo ou do site da operadora, e no e-mail ou SMS de confirmação enviado na ativação. Se você não encontrar, peça ao atendimento a data e o canal da contratação, com número de protocolo.",
      },
      {
        question: "Cancelar o serviço apaga o aplicativo do celular?",
        answer:
          "São coisas separadas: o cancelamento encerra a assinatura e a cobrança, e o aplicativo continua instalado até você removê-lo. Confira a fatura do ciclo seguinte para ver se o item saiu da conta.",
      },
    ],
  }),

  // --- One "what is an SVA section" page per seeded issuer (§7.1.1) -----
  svaSectionPage("claro-movel"),
  svaSectionPage("vivo-movel"),
  svaSectionPage("tim-movel"),
  svaSectionPage("oi"),
  svaSectionPage("sky"),
  svaSectionPage("algar"),
];

/** Every issuer slug the corpus references, deduplicated. */
export const SEO_PAGE_ISSUER_SLUGS: readonly string[] = [
  ...new Set(SEO_PAGES.map((page) => page.issuerSlug)),
];

// Validating at module load rather than inside the seed: a bad slug is a
// permanent 404 (see `seoChargeSlug`'s doc comment), and every importer of
// this module — the seed, both test files — should trip over it, not just
// the one that happens to run first.
for (const page of SEO_PAGES) seoChargeSlug(page.chargeSlug);
