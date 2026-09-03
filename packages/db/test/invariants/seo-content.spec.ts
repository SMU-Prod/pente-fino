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
 * Words that turn a description into a charge against whoever is named
 * beside them. Not a style list — every one of these, said of a named
 * company, asserts conduct this project has no basis to assert: CLAUDE.md
 * §7.0 built its lexicon from complaint text with no real invoice in hand,
 * which is evidence that a *kind of line* exists, never evidence that a
 * company did anything.
 *
 * "sem autorização" and "sem consentimento" are on the list even though
 * they are the natural way to describe the problem, because that is exactly
 * the trap: they read as neutral and land as an accusation. The corpus says
 * "confira se você contratou" instead — the §14.2 move, one level up.
 */
const ACCUSATORY_TERMS = [
  "cobrou sem", "fraude", "fraudou", "golpe", "enganou", "lesou",
  "abusiva", "abusivo", "irregular", "má-fé", "descumpriu",
  "sem autorização", "sem consentimento", "escondido", "esconde",
];

/**
 * Every product or company name the corpus itself puts on a page. The
 * issuers' own `displayName`s and aliases are *not* here: they are read out
 * of the seeded `issuers` rows at assertion time, so adding an issuer or an
 * alias widens this check automatically instead of leaving a company
 * silently unprotected by a list nobody remembered to update.
 */
const CORPUS_COMPANY_NAMES = [
  "Skeelo", "Ubook", "TIM Livros", "GoRead", "Go Read",
  "Hube Jornais", "Hube Jornal", "NBA", "NBA Básico",
  "Clube de Revistas", "FunKids", "McAfee", "Vivo Meditação Lite",
  "TDATA", "Telefônica Data", "Editora Abril", "Brisanet",
  "Netflix", "YouTube", "Prime Video", "HBO", "Telecine Play",
  "Anatel",
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
      const accusatory = ACCUSATORY_TERMS.filter((term) => matchesWord(folded, term, true));
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
});

describe("the public corpus stays inside what CLAUDE.md §7 confirmed", () => {
  it("names no ⚠️ single-source or ❔ needs-a-real-invoice term", () => {
    expect(unconfirmedTermHits(CORPUS_STRINGS)).toEqual([]);
  });
});
