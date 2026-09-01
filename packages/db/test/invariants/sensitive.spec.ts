import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runRules, type ActiveRule, type InvoiceCanonical, type RuleSpec } from "@pentefino/core";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { rules } from "../../src/schema.js";

// --- Vocabulary -------------------------------------------------------
//
// LGPD art. 5 II names five kinds of sensitive personal data; PRD.md §3's
// INV-006 repeats four of them verbatim: saúde (health), religião
// (religion), sindicato (union membership), política (political
// affiliation). Written in Brazilian Portuguese and matched
// accent-insensitively (see `stripAccents` below) because that is the
// language a real invoice or card statement is written in — an English
// list would pass every one of them and catch nothing.
//
// Entries are stems, not whole words, so one entry catches every inflected
// form a merchant description or an admin's free text is likely to use
// ("farmac" -> farmácia, farmacêutico, farmácias). Written without
// diacritics, since matching runs against accent-stripped text.
//
// Deliberately excluded: bare political-party acronyms (PT, PSDB, MDB...)
// and bare words that are common Portuguese surnames or unrelated
// vocabulary ("batista" is both a church denomination and one of the most
// common surnames in Brazil; "capela" is also a place name; "candidato" is
// routinely used for a job applicant, not just an electoral one). Each of
// those would flag an author's name or an unrelated rule far more often
// than it would ever flag a real violation. Where the sensitive sense only
// shows up combined with a second word ("igreja batista", "campanha
// eleitoral"), the multi-word phrase is listed instead of the ambiguous
// word alone.
type SensitiveCategory = "saude" | "religiao" | "sindicato" | "politica";

const SENSITIVE_VOCABULARY: Record<SensitiveCategory, string[]> = {
  // Health (LGPD "dado referente a saude"): what a pharmacy, clinic,
  // hospital or health-plan charge actually looks like on a Brazilian card
  // statement or invoice line item.
  //
  // "clinic" and "ambulator" are truncated one letter shorter than the
  // whole-word forms `clinica`/`ambulatorio` would suggest, specifically so
  // the same stem covers both the noun and the adjective
  // (clínica/clínico, ambulatório/ambulatorial) — a whole-word stem would
  // silently miss whichever form did not end the same way.
  saude: [
    "saude", "farmac", "drogaria", "drogasil", "hospital", "clinic",
    "ambulator", "pronto socorro", "medic", "enferm", "psicolog",
    "psiquiatr", "fisioterap", "odontolog", "nutricion", "fonoaudiolog",
    "oncolog", "cancer", "hiv", "aids", "plano de saude",
    "unimed", "amil", "hapvida", "notredame",
  ],
  // Religion (LGPD "filiacao a organizacao de caracter religioso"):
  // denominations and giving vocabulary the way they read on a PIX or card
  // description ("DIZIMO", "IGREJA BATISTA"), not the bare theology term.
  religiao: [
    "igreja", "paroquia", "diocese", "arquidiocese", "catedral", "templo",
    "congregacao", "sinagoga", "mesquita", "umbanda", "candomble",
    "espirita", "dizimo", "dizimista", "catolic", "evangelic",
    "igreja batista", "assembleia de deus", "testemunha de jeova",
  ],
  // Union membership (LGPD "filiacao a sindicato"). Two stems, not one:
  // "sindicat" (sindicato/sindicatos) and "sindical" (sindical/
  // sindicalista/sindicalizado/mensalidade sindical — the noun and the
  // adjective diverge right after the shared "sindica-" root, so one stem
  // cannot cover both). A single shorter "sindica" stem would cover both
  // forms too, but it would also catch "sindicância" (an administrative
  // inquiry — unrelated to union membership); stopping one letter earlier,
  // at the fork, avoids that collision without losing either real form.
  sindicato: ["sindicat", "sindical"],
  // Political affiliation (LGPD "opiniao politica"). "partid" catches
  // partido/partidario/partidaria; bare party acronyms are excluded (see
  // header note above).
  politica: ["partid", "eleitoral"],
};

const ALL_SENSITIVE_TERMS = Object.values(SENSITIVE_VOCABULARY).flat();

// Non-capturing group: the whole match *is* the matched term, so no capture
// index is needed and there is nothing for `noUncheckedIndexedAccess` to
// complain about when reading `hit[0]`.
const SENSITIVE_TERM = new RegExp(`\\b(?:${ALL_SENSITIVE_TERMS.join("|")})`, "i");

// Unicode "Combining Diacritical Marks" block: NFD decomposition splits an
// accented letter like "ã" or "ê" into a plain letter followed by one of
// these combining marks. Named as code points (rather than written as a
// regex escape) to keep the exact characters unambiguous in source control.
const COMBINING_MARKS_START = 0x0300;
const COMBINING_MARKS_END = 0x036f;

/** Strips diacritics so e.g. `saúde` and `dízimo` still match their unaccented stems. */
function stripAccents(text: string): string {
  return Array.from(text.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code < COMBINING_MARKS_START || code > COMBINING_MARKS_END;
    })
    .join("");
}

/** The first sensitive term found in `text`, or null. Accent-insensitive. */
function findSensitiveTerm(text: string): string | null {
  const hit = SENSITIVE_TERM.exec(stripAccents(text));
  return hit ? hit[0] : null;
}

/**
 * Every string value anywhere inside an arbitrary JSON-shaped value,
 * recursing into objects and arrays. `RuleSpec` is a closed union today
 * (pattern/delta/threshold/reference/confirm/arithmetic/suppressor), but
 * this walks the value structurally instead of switching on `kind`, so it
 * keeps working without changes if a future rule kind adds a free-text
 * field nobody thought to list here by name.
 */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

/**
 * Every piece of admin-authored free text a `rules` row carries: the spec
 * (whatever shape its `kind` gives it), the human-written `reason`, the
 * `slug` (an admin could just as easily name a rule after what it targets
 * as encode that in the spec), and any `legalBasis[].note`. Deliberately
 * excludes `author` (a person's name, not part of the rule's meaning),
 * `category`, `kind` and `status` (fixed enums with no free-text risk).
 */
function ruleRowText(row: { slug: string; reason: string; spec: unknown; legalBasis: unknown }): string {
  return [row.slug, row.reason, ...stringsIn(row.spec), ...stringsIn(row.legalBasis)].join("\n");
}

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/**
 * Every tracked TypeScript file under `packages/db/src/seeds` — where a
 * hard-coded starter rule catalog is expected to live once seeded (see
 * `packages/db/src/seeds/rules/pattern.ts`, planned for this same block).
 * This check runs against the file the moment sensitive vocabulary is
 * typed into it, before it is ever wired into `seedAll` and before any test
 * DB would see it as a row — the check below this one, which reads the
 * `rules` table, cannot see that far ahead.
 *
 * `execFileSync` with an argv array, never a shell string: on Windows,
 * `execSync`'s default shell is cmd.exe, which does not strip single quotes
 * the way POSIX `/bin/sh` does, so a string command with quoted globs would
 * reach git with the quotes still attached, match nothing, and pass on
 * every run for the wrong reason. See `credentials.spec.ts` for the exact
 * bug this repository already shipped once.
 */
function seedSourceFiles(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "packages/db/src/seeds"], { encoding: "utf8" });
  return out.split("\n").filter((file) => file.endsWith(".ts"));
}

// A "card" invoice's line items are exactly where a real Brazilian
// statement would carry sensitive-looking merchant descriptions: a
// pharmacy, a church tithe, a union due, a campaign donation. Amounts and
// dates are ordinary — nothing here is a duplicate, a threshold breach, or
// any other shape a legitimate content-blind rule would have a reason to
// flag — so any finding this fixture produces would have to come from a
// rule that targeted what the line item *is*, not from a rule that would
// have fired regardless of its content.
const SENSITIVE_FIXTURE_INVOICE = {
  issuer: { name: "Banco Exemplo Cartão", category: "card" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 45480,
  sections: [{
    name: "Compras",
    items: [
      { description: "Drogaria São Paulo - Farmácia", amountCents: 5990 },
      { description: "Dízimo Igreja Batista Central", amountCents: 20000 },
      { description: "Mensalidade Sindicato dos Bancários", amountCents: 4500 },
      { description: "Doação Campanha Eleitoral Partido Novo", amountCents: 14990 },
    ],
  }],
  extraction: { confidence: 0.9, warnings: [] },
} as InvoiceCanonical;

const NO_REFERENCES = { tariffs: [], flags: [] };

let ctx: TestDb;
let ruleSeq = 0;

beforeEach(async () => {
  ctx = await createTestDb();
  ruleSeq = 0;
});
afterEach(async () => { await ctx.close(); });

/** Inserts a minimal rule row for the probes below — any `kind`, any `status`. */
async function insertRule(params: { slug: string; status: string; spec: RuleSpec; reason?: string }): Promise<void> {
  ruleSeq += 1;
  await ctx.db.insert(rules).values({
    id: `rul_probe_${ruleSeq}`,
    slug: params.slug,
    category: "card",
    kind: params.spec.kind,
    spec: params.spec,
    confidenceBase: 0.5,
    status: params.status,
    author: "system",
    reason: params.reason ?? "test probe",
  });
}

/**
 * Every rule, at every status — draft, shadow, active or paused — whose
 * `ruleRowText` contains a sensitive term. Not filtered to `active` (or
 * even to `active`/`shadow`, `INV-010`'s scope): RF-125/RF-126 let a
 * `shadow` rule compute real findings and auto-promote to `active` with no
 * human sign-off, so a check that only widened as far as `shadow` would
 * still miss a `draft` or `paused` row — and nothing in the PRD's wording
 * of INV-006 ("nunca inferir ou armazenar") limits it to rules currently in
 * observation. A sensitive term simply must never be *stored*, in any row,
 * regardless of whether it is ever evaluated.
 */
async function sensitiveRuleOffenders(): Promise<{ slug: string; status: string; term: string }[]> {
  const allRules = await ctx.db.select().from(rules);
  const offenders: { slug: string; status: string; term: string }[] = [];
  for (const row of allRules) {
    const term = findSensitiveTerm(ruleRowText(row));
    if (term) offenders.push({ slug: row.slug, status: row.status, term });
  }
  return offenders;
}

describe("INV-006 · never infer or store a sensitive category from an invoice", () => {
  it("has vocabulary covering all four categories INV-006 names", () => {
    expect(Object.keys(SENSITIVE_VOCABULARY).sort()).toEqual(["politica", "religiao", "saude", "sindicato"]);
    for (const terms of Object.values(SENSITIVE_VOCABULARY)) expect(terms.length).toBeGreaterThan(0);
  });

  it("finds no rule, at any status, matching a health, religion, union or political term", async () => {
    expect(await sensitiveRuleOffenders()).toEqual([]);
  });

  // --- Proof the check is not vacuous ----------------------------------
  // Four categories, four different statuses (including two — draft and
  // paused — that INV-010's precedent never had to cover), so a check that
  // accidentally only looked at one field, one kind, or one status could
  // not pass all four by accident.

  it("catches a draft rule matching a health term (a pharmacy line item)", async () => {
    await insertRule({
      slug: "gasto-farmacia-recorrente",
      status: "draft",
      spec: { kind: "pattern", match: "farmacia|drogaria" },
    });
    expect(await sensitiveRuleOffenders()).toEqual([
      { slug: "gasto-farmacia-recorrente", status: "draft", term: "farmac" },
    ]);
  });

  it("catches a shadow rule matching a religion term (RF-125/RF-126: shadow already computes real findings and can auto-promote without human review)", async () => {
    await insertRule({
      slug: "gasto-igreja-mensal",
      status: "shadow",
      spec: { kind: "pattern", match: "dizimo|igreja batista" },
    });
    // "igreja" surfaces first, not "dizimo": `ruleRowText` joins slug before
    // spec, and the slug itself already names the category (a realistic
    // admin habit) before the scan ever reaches the pattern's own text.
    expect(await sensitiveRuleOffenders()).toEqual([
      { slug: "gasto-igreja-mensal", status: "shadow", term: "igreja" },
    ]);
  });

  // Slugs below are deliberately neutral (no vocabulary of their own), so
  // the hit can only come from the spec field named in the test title —
  // unlike the two tests above, which let the slug itself carry the term.
  it("catches an active rule matching a union term, hidden inside a threshold expression rather than a pattern match", async () => {
    await insertRule({
      slug: "desconto-recorrente-alto",
      status: "active",
      spec: { kind: "threshold", expr: "sindicato_mensalidade_valor", operator: ">", value: 0 },
    });
    expect(await sensitiveRuleOffenders()).toEqual([
      { slug: "desconto-recorrente-alto", status: "active", term: "sindicat" },
    ]);
  });

  it("catches a paused rule matching a political term, asked as a confirm question", async () => {
    await insertRule({
      slug: "confirma-cobranca-recorrente",
      status: "paused",
      spec: {
        kind: "confirm",
        question: "Essa cobranca e uma doacao de campanha eleitoral?",
        options: ["sim", "nao"],
        onNo: "create_finding",
      },
    });
    expect(await sensitiveRuleOffenders()).toEqual([
      { slug: "confirma-cobranca-recorrente", status: "paused", term: "eleitoral" },
    ]);
  });

  // --- Defense in depth: the vocabulary hard-coded into seed source -----
  // `sensitiveRuleOffenders` above only ever sees a row once something has
  // inserted it into the `rules` table. A starter catalog written directly
  // in TypeScript (`packages/db/src/seeds/rules/...`, landing elsewhere in
  // this same block) is sensitive-vocabulary-checkable the moment it is
  // typed, before it is wired into `seedAll` and before any test DB would
  // ever see it as a row.
  it("has no sensitive vocabulary hard-coded into a packages/db/src/seeds source file", () => {
    const root = repoRoot();
    const offenders: string[] = [];
    for (const file of seedSourceFiles(root)) {
      const text = readFileSync(join(root, file), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        const term = findSensitiveTerm(line);
        if (term) offenders.push(`${file}:${index + 1} (${term})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // --- The engine: no finding is keyed on a sensitive term ---------------

  it("produces no finding for a sensitive-looking fixture invoice, given today's real rule catalog", () => {
    // `[]` is not a stand-in for "some rules, sensitive-vocabulary-free" —
    // it is today's actual active/shadow catalog: no seed populates `rules`
    // yet (`packages/db/src/seeds/index.ts`'s `seedAll` only touches
    // `issuers` and `prompts`), so this is a real call against the real
    // production state, not a vacuous one. Once a starter catalog is seeded
    // (this same block, later task), this line should be replaced with
    // rules actually loaded from a test DB.
    expect(
      runRules({
        invoice: SENSITIVE_FIXTURE_INVOICE,
        previous: null,
        rules: [],
        answers: {},
        references: NO_REFERENCES,
      }),
    ).toEqual([]);
  });

  // The above is only a meaningful non-finding because there is nothing to
  // fire — it does not prove the check would catch a sensitive rule that
  // did reach the engine, because `runRules` currently throws for *any*
  // non-empty rule set (RF-121's evaluators are still landing in this same
  // block; see `engine.ts` and `engine.test.ts`'s own
  // "throws naming E2 and the unevaluated rules" test), so a genuinely
  // sensitive `ActiveRule` cannot be run through it today without that
  // unrelated gap masking the result either way. What can be proven today
  // is that the same detector gating the rows above also covers
  // `ActiveRule` — the exact shape `runRules` accepts — so a sensitive rule
  // is caught before it would ever reach the engine, regardless of which
  // of the two shapes (DB row or engine input) it is inspected in.
  it("flags a sensitive term inside an ActiveRule's spec too — the exact shape runRules accepts, not just the DB row shape", () => {
    const sensitiveRule: ActiveRule = {
      slug: "probe-engine-boundary",
      version: 1,
      spec: { kind: "pattern", match: "farmacia|hospital" },
      confidenceBase: 0.5,
      shadow: false,
      legalBasis: [],
      issuerId: null,
    };
    expect(findSensitiveTerm(stringsIn(sensitiveRule.spec).join("\n"))).toBe("farmac");

    const cleanRule: ActiveRule = {
      ...sensitiveRule,
      slug: "probe-engine-boundary-clean",
      spec: { kind: "pattern", match: "cobranca duplicada no mesmo ciclo" },
    };
    expect(findSensitiveTerm(stringsIn(cleanRule.spec).join("\n"))).toBeNull();
  });
});
