import { beforeAll, describe, expect, it } from "vitest";
import { lintUserFacingText } from "@pentefino/ai";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { schema } from "../../src/index.js";
import { SEO_PAGES, type SeoPageSeed } from "../../src/seeds/seo-pages.content.js";

/**
 * The honesty gate on E10's public corpus (`seeds/seo-pages.content.ts`).
 *
 * Three properties, each a different way the same page can stop being
 * honest:
 *
 *  1. **INV-004/INV-005** — `lintUserFacingText` on every user-facing
 *     string, with **no** citation ranges granted. Nothing in the corpus is
 *     a verbatim quotation of a norm (the pages name articles and describe
 *     what they provide for; they do not reproduce their text), so nothing
 *     earns §14.3's quotation exemption for "indevido"/"ilegal".
 *  2. **No company is accused.** A page about a charge type is not a page
 *     accusing an issuer, and not a page accusing the service company
 *     either — several of the products described here are legitimately sold
 *     with documented opt-in (CLAUDE.md §7.1.2: Ubook has a published Claro
 *     billing-authorisation contract, McAfee has its own Vivo activation
 *     page). Naming a real company as having done something wrong is a
 *     legal problem, not a copy nit, and it is the single most likely thing
 *     to go wrong in prose written from complaint text.
 *  3. **No unconfirmed term.** The corpus may not quietly widen past what
 *     §7 marked ✅ confirmed by naming a ⚠️ single-source or ❔
 *     needs-a-real-invoice item in passing.
 *
 * Each check has a probe below that feeds it a deliberately bad fixture, so
 * the check is known to be capable of failing rather than merely observed
 * passing.
 */

// ---------------------------------------------------------------------------
// The strings under test
// ---------------------------------------------------------------------------

/** One user-facing string, with enough context to name it in a failure. */
type Labeled = { label: string; text: string };

function pageStrings(page: SeoPageSeed): Labeled[] {
  const key = `${page.issuerSlug}/${page.chargeSlug}`;
  const out: Labeled[] = [
    { label: `${key} · title`, text: page.title },
    { label: `${key} · intro`, text: page.content.intro },
  ];
  for (const [s, section] of page.content.sections.entries()) {
    out.push({ label: `${key} · section[${s}] heading`, text: section.heading });
    for (const [p, paragraph] of section.paragraphs.entries()) {
      out.push({ label: `${key} · section[${s}] paragraph[${p}]`, text: paragraph });
    }
  }
  for (const [f, entry] of page.content.faq.entries()) {
    out.push({ label: `${key} · faq[${f}] question`, text: entry.question });
    out.push({ label: `${key} · faq[${f}] answer`, text: entry.answer });
  }
  out.push({ label: `${key} · provenance`, text: page.content.provenance });
  return out;
}

const CORPUS_STRINGS: Labeled[] = SEO_PAGES.flatMap(pageStrings);

// ---------------------------------------------------------------------------
// 1 · INV-004 / INV-005
// ---------------------------------------------------------------------------

/**
 * `lintUserFacingText` is called with **no** `citations`, which is what
 * makes "indevido"/"indevida"/"ilegal" violations wherever they appear. The
 * exemption §14.3 grants is for verbatim quotation of a norm or of a third
 * party, and this corpus quotes neither: it names articles and says what
 * they provide for, in its own words. Granting a range here would be
 * granting it to the product's own voice, which is precisely what INV-004
 * forbids.
 */
function lintFailures(entries: readonly Labeled[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    const result = lintUserFacingText(entry.text);
    if (!result.ok) {
      const terms = result.violations.map((v) => `${v.term} (${v.reason})`).join(", ");
      failures.push(`${entry.label}: ${terms}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// 2 · no company is accused
// ---------------------------------------------------------------------------

/**
 * Words and constructions that turn a description into a charge against
 * whoever is named beside them. Not a style list — every one of these, said
 * of a named company, asserts conduct this project has no basis to assert:
 * CLAUDE.md §7.0 built its lexicon from complaint text with no real invoice
 * in hand, which is evidence that a *kind of line* exists, never evidence
 * that a company did anything.
 *
 * Three shapes, because an accusation has three shapes.
 *
 * **Stems.** The first version of this list held lemmas — "enganou",
 * "lesou", "descumpriu" — and matched them whole-word with the regular
 * plural. That caught the past tense and nothing else: "a TIM engana o
 * consumidor" and "a Claro descumpre a norma" walked straight through the
 * check written to stop them. Portuguese verbs inflect far past what an "s"
 * covers, so the verbs and the deverbal adjectives are matched by root plus
 * whatever letters follow. That is deliberately over-inclusive: "les" also
 * matches "leste", and "golp" also matches "golpear". A false positive here
 * fails the build loudly on a sentence a human then reads; a false negative
 * publishes an accusation nobody re-reads.
 */
const ACCUSATORY_STEMS = [
  "engan", // engana, enganou, enganoso, engano
  "les", // lesa, lesou, lesado, lesivo, lesão
  "descumpr", // descumpre, descumpriu, descumprindo, descumprido
  "fraud", // fraude, fraudou, fraudulento, fraudada
  "golp", // golpe, golpes, golpista, golpear
  "abusiv", // abusiva, abusivo, abusivamente
  "irregular", // irregular, irregulares, irregularidade
  "escond", // esconde, escondeu, escondido, escondendo
  "ocult", // oculta, ocultou, ocultado, ocultação
  "ludibri", // ludibria, ludibriou, ludibriado
  "deliberad", // deliberado, deliberadamente
  "proposital", // proposital, propositalmente
  "intencional", // intencional, intencionalmente
];

/** Fixed phrases, matched whole-word with the regular Portuguese plural, as before. */
const ACCUSATORY_PHRASES = ["má-fé", "de propósito"];

/**
 * **Constructions.** "sem autorização" and "sem consentimento" used to be
 * two literal entries, and they are the natural way to describe the problem
 * — which is exactly the trap: they read as neutral and land as an
 * accusation. But they are two members of an open family, and the other
 * members were passing: "sem que o cliente pedisse", "sem avisar", "sem
 * pedido do cliente" all say the same thing about a named company. What is
 * matched is therefore the shape, not the wording.
 *
 * The corpus says "confira se você contratou" and "peça a data e o canal da
 * contratação" instead — the §14.2 move, one level up. It also legitimately
 * writes "sem cancelar", "sem mexer no plano" and "sem abreviar", which is
 * why the verb and noun lists below are enumerated rather than left as a
 * wildcard after "sem".
 */
const ACCUSATORY_CONSTRUCTIONS: ReadonlyArray<{ label: string; source: string }> = [
  {
    label: "sem que <alguém> …",
    source: "sem\\s+que\\s+(?:o|a|os|as|voce|voces|ninguem|nenhum|nenhuma|alguem)\\b",
  },
  {
    label: "sem <verbo>",
    source:
      "sem\\s+(?:pedir|solicitar|avisar|informar|comunicar|autorizar|consentir|saber|perceber|combinar|contratar|querer|assinar)\\b",
  },
  {
    label: "sem <substantivo>",
    source:
      "sem\\s+(?:autorizacao|consentimento|aviso|permissao|aceite|conhecimento|contratacao|pedido|solicitacao|anuencia|previo\\s+aviso)\\b",
  },
];

/**
 * Every product or company name the corpus itself puts on a page. The
 * issuers' own `displayName`s and aliases are *not* here: they are read out
 * of the seeded `issuers` rows at assertion time, so adding an issuer or an
 * alias widens this check automatically instead of leaving a company
 * silently unprotected by a list nobody remembered to update.
 *
 * This half cannot be read from anywhere — the corpus is prose, and the
 * names it puts in play are whatever the author typed. So it is guarded from
 * both ends instead, by "the corpus names nobody this file has not been told
 * about" below: every list here must still be present in the corpus, and
 * every capitalised word in the corpus must be accounted for by one of these
 * two lists. Adding a page that names a new partner therefore fails the
 * suite until the name is classified, which is the only way this list can be
 * kept honest without a name extractor nobody would trust.
 */
const CORPUS_COMPANY_NAMES = [
  "Skeelo", "Ubook", "TIM Livros", "GoRead", "Go Read",
  "Hube Jornais", "Hube Jornal", "NBA", "NBA Básico",
  "Clube de Revistas", "FunKids", "McAfee", "Vivo Meditação Lite",
  "TDATA", "Telefônica Data", "Editora Abril", "Brisanet",
  "Netflix", "YouTube", "Prime Video", "HBO", "Telecine Play",
  "Anatel",
];

/**
 * Product-name words that are not themselves a company: the plan and edition
 * words the corpus quotes off a bill line ("Skeelo Top", "McAfee Safe
 * Connect", "Ubook Jornais"). They belong to a name in the list above, so
 * they are not separate companies, but they are capitalised and so must be
 * declared somewhere for the drift guard to pass.
 */
const CORPUS_PRODUCT_WORDS = [
  "Top", "Promo", "Premium", "Intermediário", "Audiobooks", // Skeelo's plan names
  "Proteção", "Safe", "Connect", // McAfee Proteção, McAfee Safe Connect
];

/**
 * Capitalised words the corpus writes that name no company at all: ordinary
 * Portuguese words at the start of a sentence, the bill-section names quoted
 * verbatim off `issuers.sections`, and the norms and file formats the pages
 * mention. Long and boring on purpose — its length is what makes the guard
 * above cheap to satisfy honestly and impossible to satisfy by accident. A
 * new word here is one line; a new *company* here would be a mistake a
 * reviewer can see, which is the whole point of making them separate lists.
 */
const NOT_A_COMPANY = [
  // Ordinary words, almost all of them sentence-initial.
  "A", "Ainda", "Algum", "Anote", "Antes", "Ao", "As", "Assinaturas", "Cada",
  "Cancelar", "Cancelei", "Com", "Comece", "Como", "Compare", "Confira",
  "Copie", "Dá", "Depende", "Depois", "É", "Ela", "Ele", "Em", "Entre",
  "Essa", "Esse", "Esta", "Estão", "Este", "Eu", "Existe", "Faça", "Fora",
  "Isso", "Ler", "Meu", "Muda", "Multiplique", "Na", "Nada", "Não", "Nem",
  "Nenhum", "Nenhuma", "No", "Nos", "O", "Olhe", "Onde", "Os", "Para",
  "Peça", "Pedidos", "Pedindo", "Pela", "Pelo", "Percorra", "Pode", "Por",
  "Porque", "Posso", "Preciso", "Procure", "Quais", "Qual", "Quando", "Que",
  "Renovação", "São", "Se", "Sem", "Sim", "Sob", "Tenho", "Terceiro",
  "Terceiros", "Um", "Uma", "Vale", "Valor", "Vi",
  // Bill-section vocabulary, quoted verbatim from `issuers.sections`.
  "Adicionais", "Aplicativos", "Cobrança", "COBRANCAS", "Contratados",
  "Digitais", "FACILIDADES", "Mensais", "OUTRAS", "Outros", "Pacotes",
  "SERVICOS", "Serviço", "Serviços", "SVA", "Valores", "III",
  // Norms, institutions, channels and file formats. "Ministério Público" is
  // named by `SEO_PROVENANCE` as one of §7.0's four source classes — the
  // body that brought the case, never a company this corpus describes.
  "CDC", "Decreto", "Ministério", "Público", "Resolução", "PDF", "PDFs",
  "SMS", "R",
];

/** Accent-folding and lowercasing, the same normalisation `lintUserFacingText` applies. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Abbreviations whose period does not end a sentence. Without this, the
 * splitter below would cut "A Claro citou o art. 42 e falou em má-fé." in
 * two and find no sentence holding both a name and an accusatory term — the
 * check would report clean on a string that is exactly what it exists to
 * catch. The single-letter alternative covers initials and "S.A.", which
 * appears inside two seeded issuer aliases ("Claro S.A.", "TIM S.A.").
 *
 * Every judgement call in this splitter is made in the direction of *longer*
 * sentences: it does not split on ";", ":" or an em dash either. A longer
 * window can only make the check stricter, and a check that is too strict
 * fails loudly on a sentence a human then reads, while one that is too
 * lenient passes silently on prose nobody re-reads.
 */
const NON_TERMINAL_ABBREVIATION = /\b(?:arts?|res|dec|inc|etc|n[ºo]?|p|ex|sr|sra|[a-z])\.(?=\s|$)/gi;

const PROTECTED_PERIOD = "\u0001";

function splitSentences(text: string): string[] {
  const protectedText = text.replace(NON_TERMINAL_ABBREVIATION, (m) => m.replace(".", PROTECTED_PERIOD));
  return protectedText
    .split(/(?<=[.!?…])\s+/u)
    .map((sentence) => sentence.split(PROTECTED_PERIOD).join("."))
    .filter((sentence) => sentence.trim().length > 0);
}

/**
 * Whole-word match on already-folded text. Names are matched exactly (a
 * company name does not pluralize); accusatory terms are widened with the
 * regular Portuguese plural the way `packages/ai`'s lint does, so
 * "abusiva"/"abusivas" and "golpe"/"golpes" are one entry each. Multi-word
 * terms rejoin on `\s+`, so a line break between the words still matches.
 */
function matchesWord(foldedHaystack: string, term: string, withPlural: boolean): boolean {
  const words = fold(term).split(/\s+/).map(escapeRegExp);
  const pattern = words.map((w) => (withPlural ? `${w}(?:es|s)?` : w)).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "u").test(foldedHaystack);
}

/**
 * Root plus whatever letters follow it, anchored at a word start. `engan`
 * matches "engana", "enganou" and "enganoso" and does not match "desengano"
 * or a word that merely contains the letters.
 */
function matchesStem(foldedHaystack: string, stem: string): boolean {
  const pattern = `(?<![\\p{L}\\p{N}])${escapeRegExp(fold(stem))}\\p{L}*(?![\\p{L}\\p{N}])`;
  return new RegExp(pattern, "u").test(foldedHaystack);
}

/** Every accusatory shape present in one already-folded sentence, by label. */
function accusatoryTermsIn(foldedSentence: string): string[] {
  return [
    ...ACCUSATORY_STEMS.filter((stem) => matchesStem(foldedSentence, stem)).map((s) => `${s}…`),
    ...ACCUSATORY_PHRASES.filter((phrase) => matchesWord(foldedSentence, phrase, true)),
    ...ACCUSATORY_CONSTRUCTIONS.filter((c) => new RegExp(c.source, "u").test(foldedSentence)).map(
      (c) => c.label,
    ),
  ];
}

/**
 * Sentence-scoped, not document-scoped. A page that explains the mechanism
 * of third-party billing will inevitably contain both company names and
 * words about things going wrong; asserting they never co-occur anywhere on
 * a 700-word page would either be unsatisfiable or, if satisfied, would mean
 * the page said nothing. The property that actually matters is the one a
 * reader perceives: is *this company* being called *this thing*, here, in
 * one sentence.
 */
function accusationHits(entries: readonly Labeled[], names: readonly string[]): string[] {
  const hits: string[] = [];
  for (const entry of entries) {
    for (const sentence of splitSentences(entry.text)) {
      const folded = fold(sentence);
      const accusatory = accusatoryTermsIn(folded);
      if (accusatory.length === 0) continue;
      const named = names.filter((name) => matchesWord(folded, name, false));
      if (named.length === 0) continue;
      hits.push(`${entry.label}: [${named.join(", ")}] beside [${accusatory.join(", ")}] in ${JSON.stringify(sentence)}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 3 · nothing the lexicon left unconfirmed
// ---------------------------------------------------------------------------

/**
 * Every SVA item, aggregator, processor prefix and insurance name CLAUDE.md
 * §7 marked ⚠️ (one source) or ❔ (needs a real invoice). None of them may
 * appear on a published page, not even as an aside — a page that lists
 * "Skeelo, GoRead e Babbel" reads as one uniform claim, and the reader has
 * no way to see that the last name rests on a single complaint inside a
 * combined list.
 *
 * Two of these are ordinary Portuguese phrases as well as ⚠️ product names
 * ("Proteção Financeira", "Mais Proteção"), which is the reason this check
 * is worth running over prose rather than over a list of item names: the way
 * an unconfirmed name gets published is by being written by accident.
 */
const UNCONFIRMED_LEXICON_TERMS = [
  // §7.1.3 — SVA items with a single source
  "Abril News Digital", "Babbel", "Vivo Recado", "BandNews", "Lionsgate", "NewsCo", "newco",
  // §7.1.4 — aggregators marked ❔
  "M4U", "Multidisplay", "Movile",
  // §7.2 — the low-confidence processor descriptor prefixes
  "MERCADOPAGO*", "EC*", "Ebn*", "Pg*", "STRIPE",
  // §7.3 — insurance names marked ⚠️ or ❔
  "Proteção Financeira", "Seguro de Capitalização", "Mais Proteção", "Seguro Conta Paga",
];

/**
 * Substring semantics, not whole-word: several of these terms carry `*` or a
 * trailing `+` (`EC*`, `Lionsgate+`), for which a word boundary means
 * nothing, and a partial appearance of an unconfirmed name is exactly as
 * unpublishable as a whole one. Words are rejoined on `\s+` so a line break
 * inside a two-word name still matches.
 */
function unconfirmedTermHits(entries: readonly Labeled[]): string[] {
  const hits: string[] = [];
  for (const entry of entries) {
    const folded = fold(entry.text);
    for (const term of UNCONFIRMED_LEXICON_TERMS) {
      const pattern = fold(term).split(/\s+/).map(escapeRegExp).join("\\s+");
      if (new RegExp(pattern, "u").test(folded)) hits.push(`${entry.label}: ${term}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 4 · the corpus names nobody this file has not been told about
// ---------------------------------------------------------------------------

/**
 * Every capitalised word the corpus writes. Word-level rather than
 * phrase-level on purpose: a phrase extractor has to guess where a name ends
 * ("Skeelo Top, Skeelo Promo e Skeelo Audiobooks" is three names, not one),
 * and a guess is exactly what must not sit between a new company name and
 * the check that protects it. One capitalised word is a fact; whether it is
 * a company is a judgement, and this file makes that judgement explicit by
 * requiring every such word to be in one of three declared lists.
 */
function capitalisedWords(entries: readonly Labeled[]): Map<string, string[]> {
  const byWord = new Map<string, string[]>();
  for (const entry of entries) {
    for (const match of entry.text.matchAll(/\p{Lu}[\p{L}\p{N}]*/gu)) {
      const word = match[0];
      const seen = byWord.get(word) ?? [];
      if (!seen.includes(entry.label)) seen.push(entry.label);
      byWord.set(word, seen);
    }
  }
  return byWord;
}

/** Every word of every declared name, folded — the vocabulary a candidate is checked against. */
function declaredWords(companyNames: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const name of [...companyNames, ...CORPUS_PRODUCT_WORDS, ...NOT_A_COMPANY]) {
    for (const part of fold(name).split(/[\s.]+/)) if (part.length > 0) words.add(part);
  }
  return words;
}

/**
 * Capitalised words the corpus writes that no declared list accounts for.
 * This is the drift guard the company-name half was missing: the issuer half
 * is read from `issuers` and widens on its own, so a new operator is
 * protected the moment it is seeded, while `CORPUS_COMPANY_NAMES` is typed by
 * hand and a page added later could name a partner nothing protects. It
 * cannot now: the new name is a capitalised word, no list claims it, and the
 * suite fails until somebody decides which list it belongs in.
 */
function undeclaredNames(entries: readonly Labeled[], companyNames: readonly string[]): string[] {
  const declared = declaredWords(companyNames);
  const out: string[] = [];
  for (const [word, labels] of capitalisedWords(entries)) {
    if (declared.has(fold(word))) continue;
    out.push(`${word} (in ${labels.slice(0, 2).join(", ")}${labels.length > 2 ? ", …" : ""})`);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Probes: each check, fed a deliberately bad fixture
// ---------------------------------------------------------------------------

function fixture(text: string): Labeled[] {
  return [{ label: "fixture", text }];
}

/**
 * Every name the accusation check protects: the seeded issuers' own
 * `displayName`s and aliases, read out of the database so the set widens on
 * its own when §20.1 grows, plus the products and companies the corpus
 * names itself. Loaded once for the file — the seeds are identical in every
 * `createTestDb`, and nothing here writes.
 */
let COMPANY_NAMES: string[] = [];

beforeAll(async () => {
  const ctx: TestDb = await createTestDb();
  try {
    const rows = await ctx.db
      .select({ displayName: schema.issuers.displayName, aliases: schema.issuers.aliases })
      .from(schema.issuers);
    COMPANY_NAMES = [
      ...new Set([...rows.flatMap((r) => [r.displayName, ...(r.aliases ?? [])]), ...CORPUS_COMPANY_NAMES]),
    ];
  } finally {
    await ctx.close();
  }
}, 60_000);

describe("the checks themselves catch a deliberately bad string", () => {
  it("protects the seeded issuers by name, not only the corpus's own list", () => {
    // If this ever comes back empty the two assertions below would still
    // pass while protecting nobody.
    expect(COMPANY_NAMES).toContain("Vivo");
    expect(COMPANY_NAMES).toContain("Telefônica Brasil");
    expect(COMPANY_NAMES).toContain("Skeelo");
  });

  it("lint check flags forbidden vocabulary", () => {
    const bad = fixture("Nosso parecer jurídico é que essa cobrança é ilegal e você vai receber em dobro.");
    expect(lintFailures(bad)).toHaveLength(1);
  });

  it("lint check flags the conditional terms with no citation range granted", () => {
    // The §14.3 exemption is never claimed by this corpus, so "indevida" is
    // a violation here even though it sits next to a real article number —
    // proximity to a norm is not quotation of one.
    expect(lintFailures(fixture("A norma do art. 42 trata da cobrança indevida."))).toHaveLength(1);
  });

  it("accusation check flags a company named beside an accusatory term", () => {
    expect(accusationHits(fixture("A Vivo cobrou sem autorização o Skeelo de milhares de clientes."), COMPANY_NAMES))
      .toHaveLength(1);
  });

  it("accusation check flags a service company, not only an issuer", () => {
    expect(accusationHits(fixture("O que a Editora Abril fez com o GoRead foi um golpe."), COMPANY_NAMES))
      .toHaveLength(1);
  });

  it("accusation check flags the inflected form of an accusatory term", () => {
    expect(accusationHits(fixture("As cobranças da TIM são abusivas."), COMPANY_NAMES)).toHaveLength(1);
  });

  /**
   * One poisoned sentence per construction the check must catch. Every one of
   * these was written *before* the matcher could catch it and watched failing:
   * a lemma list ("enganou", "lesou", "descumpriu") lets every other
   * conjugation of the same verb through, and the two "sem …" entries let
   * every other way of saying the same thing through. The last row is the
   * §7.1.2 phrase about TDATA's label that this corpus consciously declined
   * to publish — the check that exists to stop it being published could not
   * have seen it.
   *
   * A row here is a sentence a reader would recognise instantly as an
   * accusation against a named company. If one of them ever stops failing to
   * be caught, the matcher lost coverage.
   */
  const POISONED: Array<[string, string]> = [
    ["conjugated -ar verb (engana)", "A TIM engana o consumidor com o nome do serviço."],
    ["conjugated -ar verb (lesa)", "A Vivo lesa os clientes que não conferem a fatura."],
    ["conjugated -ir verb (descumpre)", "A Claro descumpre a norma quando não responde."],
    ["adjectival form (fraudulentas)", "As cobranças da Vivo são fraudulentas."],
    ["past tense (escondeu)", "A TIM escondeu o valor real do TIM Livros."],
    ["synonym stem (oculta)", "A Claro oculta o item do Ubook na fatura."],
    ["nominalisation (irregularidades)", "A Sky cometeu irregularidades na cobrança do cliente."],
    ["agent noun (golpista)", "A Oi agiu como golpista com quem assinou."],
    ["sem que <alguém> <verbo>", "A Claro ativou o Ubook sem que o cliente pedisse."],
    ["sem <verbo>", "A Vivo ativou o McAfee sem avisar o cliente."],
    ["sem <substantivo>", "O Skeelo entrou na conta sem pedido do cliente."],
    ["intent adverb (deliberadamente)", "O nome TDATA é deliberadamente pouco claro."],
    ["intent adverb (propositalmente)", "A Vivo cobrou o Skeelo propositalmente."],
  ];

  it.each(POISONED)("accusation check flags %s", (_label, text) => {
    expect(accusationHits(fixture(text), COMPANY_NAMES)).toHaveLength(1);
  });

  // The mirror of the table above: ordinary sentences this corpus actually
  // wants to write, which the widened matcher must still let through. "sem
  // cancelar", "sem abreviar" and "sem mexer" are all in the shipped corpus.
  it.each([
    "Dá para cancelar o item sem mexer no plano, e sem cancelar o resto.",
    "Use o texto exato da fatura da Vivo, sem abreviar.",
    "O Skeelo segue na conta sem nenhuma outra ação depois da contratação.",
  ])("accusation check leaves ordinary prose alone: %s", (text) => {
    expect(accusationHits(fixture(text), COMPANY_NAMES)).toEqual([]);
  });

  // Scoping is the whole point: a document-wide check would flag the two
  // sentences below, and a page that explains the mechanism honestly cannot
  // avoid having a company name in one paragraph and the word "fraude" in
  // another. What must never happen is the two meeting in one sentence.
  it("accusation check does not flag a name and a term in different sentences", () => {
    const separate = fixture(
      "A McAfee é vendida pela operadora com ativação na página da própria empresa. Uma fraude é outra coisa e não é o que esta página descreve.",
    );
    expect(accusationHits(separate, COMPANY_NAMES)).toEqual([]);
  });

  // And the sentence splitter must not manufacture that separation out of an
  // abbreviation: splitting naively on every period would cut this string
  // after "art." and report it clean.
  it("accusation check is not fooled by a period inside an abbreviation", () => {
    expect(accusationHits(fixture("A Claro citou o art. 42 e falou em má-fé."), COMPANY_NAMES))
      .toHaveLength(1);
  });

  it("unconfirmed-term check flags a ⚠️ item named in passing", () => {
    expect(unconfirmedTermHits(fixture("O item Babbel também aparece na mesma seção da fatura."))).toHaveLength(1);
  });

  it("unconfirmed-term check flags a ⚠️ name written as ordinary prose", () => {
    // "Mais Proteção" is a ⚠️ product name of §7.3 and also a phrase anyone
    // would write about an antivirus without thinking about it.
    expect(unconfirmedTermHits(fixture("O antivírus promete mais proteção para o aparelho."))).toHaveLength(1);
  });

  it("drift guard flags a partner named by a page but by no list", () => {
    const newPartner = fixture("O pacote inclui uma assinatura do Deezer, cobrada na mesma fatura.");
    expect(undeclaredNames(newPartner, COMPANY_NAMES)).toHaveLength(1);
  });

  it("drift guard flags a name at the start of a sentence, where a new page would put it", () => {
    // The realistic shape of the miss: a new charge page's title and intro
    // both open with the product's name.
    expect(undeclaredNames(fixture("Spotify na conta da Vivo: o que é essa linha"), COMPANY_NAMES))
      .toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe("INV-004/INV-005 · the public corpus carries no forbidden vocabulary", () => {
  it("passes lintUserFacingText on every string, with no citation range granted", () => {
    expect(lintFailures(CORPUS_STRINGS)).toEqual([]);
  });

  it("has strings to check in the first place", () => {
    // Otherwise every assertion in this file passes on an empty corpus.
    expect(CORPUS_STRINGS.length).toBeGreaterThan(100);
  });
});

describe("no company in the public corpus is named as having done something wrong", () => {
  it("never puts a company name in the same sentence as an accusatory term", () => {
    expect(accusationHits(CORPUS_STRINGS, COMPANY_NAMES)).toEqual([]);
  });

  // The two halves of the protected-name set drift in opposite directions.
  // The issuer half is read from `issuers` and widens on its own. The corpus
  // half is typed by hand, so it is pinned from both ends here: nothing the
  // corpus names may be missing from it, and nothing in it may have stopped
  // being named.
  it("names no company the accusation check has not been told about", () => {
    expect(undeclaredNames(CORPUS_STRINGS, COMPANY_NAMES)).toEqual([]);
  });

  it("keeps no company name the corpus no longer uses", () => {
    const corpus = fold(CORPUS_STRINGS.map((entry) => entry.text).join("\n"));
    const stale = CORPUS_COMPANY_NAMES.filter((name) => !matchesWord(corpus, name, false));
    expect(stale).toEqual([]);
  });
});

describe("the public corpus stays inside what CLAUDE.md §7 confirmed", () => {
  it("names no ⚠️ single-source or ❔ needs-a-real-invoice term", () => {
    expect(unconfirmedTermHits(CORPUS_STRINGS)).toEqual([]);
  });
});
