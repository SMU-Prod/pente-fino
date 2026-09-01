import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  compileSafePattern, InvoiceCanonical, normalizeDescription, RULE_KINDS, runRules,
  type ActiveRule,
} from "@pentefino/core";
import { createTestDb, type TestDb } from "../../testing.js";
import { rules } from "../../schema.js";
import {
  LEXICON_RULES, seedLexiconRules, RN_020, RN_021, RN_021_CONFIRM, RN_023,
} from "./lexicon.js";
import { LEXICON_FIXTURES } from "./lexicon.fixtures.js";

const ALL_SLUGS = [RN_020, RN_021, RN_021_CONFIRM, RN_023];

let ctx: TestDb;
beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

async function lexiconRows() {
  return ctx.db.select().from(rules).where(inArray(rules.slug, ALL_SLUGS));
}

describe("seedLexiconRules", () => {
  it("is already wired into seedAll: createTestDb's db has all four RN-020/021/023 rows", async () => {
    const rows = await lexiconRows();
    expect(rows.map((r) => r.slug).sort()).toEqual([...ALL_SLUGS].sort());
  });

  it("gives every rule shadow status, never draft/active/paused (RF-125) — CLAUDE.md §7.0 gives the same " +
    "instruction for its own reasons: these terms came from complaint text, not from a real invoice", async () => {
    const rows = await lexiconRows();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "shadow")).toBe(true);
  });

  it("sets a ~7-day shadowUntil on first insert", async () => {
    const rows = await lexiconRows();
    const now = Date.now();
    for (const row of rows) {
      expect(row.shadowUntil).not.toBeNull();
      const deltaMs = row.shadowUntil!.getTime() - now;
      expect(deltaMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      expect(deltaMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    }
  });

  it("gives every rule a non-empty legalBasis with a valid effect (RF-129) — including RN-023, whose " +
    "citation grounds a classification rather than an accusation (see lexicon.ts's own doc comment)", async () => {
    const rows = await lexiconRows();
    const validEffects = ["dobro", "suspensao", "cancelamento", "amostra_gratis", "vedada", "limite"];
    for (const row of rows) {
      expect(row.legalBasis.length).toBeGreaterThan(0);
      for (const ref of row.legalBasis) {
        expect(ref.law.length).toBeGreaterThan(0);
        expect(ref.article.length).toBeGreaterThan(0);
        expect(validEffects).toContain(ref.effect);
      }
    }
  });

  it("keeps the kind column consistent with spec.kind, and both are valid RuleKind values", async () => {
    const rows = await lexiconRows();
    for (const row of rows) {
      expect(RULE_KINDS).toContain(row.kind);
      expect(row.kind).toBe(row.spec.kind);
    }
  });

  it("RN-021 is seeded as two rows (pattern + confirm) sharing one business rule, never a single row " +
    "pretending to have two kinds at once", async () => {
    const rows = await lexiconRows();
    const rn021 = rows.find((r) => r.slug === RN_021);
    const rn021Confirm = rows.find((r) => r.slug === RN_021_CONFIRM);
    expect(rn021?.kind).toBe("pattern");
    expect(rn021Confirm?.kind).toBe("confirm");
  });

  it("RN-021's confirm fallback sits below RF-124's 0,55 display threshold", async () => {
    const rows = await lexiconRows();
    const rn021Confirm = rows.find((r) => r.slug === RN_021_CONFIRM);
    expect(rn021Confirm?.confidenceBase).toBeLessThan(0.55);
  });

  it("RN-020 lands at the 0,88 anchor-scoped confidence, not the unscoped 0,80 base (see lexicon.ts's own " +
    "doc comment for why only one tier is seeded)", async () => {
    const rows = await lexiconRows();
    const rn020 = rows.find((r) => r.slug === RN_020);
    expect(rn020?.confidenceBase).toBe(0.88);
    expect(rn020?.spec.kind).toBe("pattern");
    if (rn020?.spec.kind === "pattern") {
      expect(rn020.spec.sections?.length).toBeGreaterThan(0);
    }
  });

  it("is idempotent: seeding twice does not duplicate rows", async () => {
    await seedLexiconRules(ctx.db);
    await seedLexiconRules(ctx.db);
    expect(await lexiconRows()).toHaveLength(4);
  });

  it("refreshes content on reseed but leaves status/shadowUntil alone, so a redeploy cannot undo " +
    "RF-126/127's promotion or pause", async () => {
    await ctx.db.update(rules).set({ status: "active", shadowUntil: null }).where(eq(rules.slug, RN_020));

    await seedLexiconRules(ctx.db);

    const [promoted] = await ctx.db.select().from(rules).where(eq(rules.slug, RN_020));
    expect(promoted?.status).toBe("active");
    expect(promoted?.shadowUntil).toBeNull();
  });
});

describe("LEXICON_RULES: every pattern.match is safe (safe-regex.ts) and stays under the 200-char cap", () => {
  for (const rule of LEXICON_RULES) {
    if (rule.spec.kind !== "pattern") continue;
    it(`${rule.slug}: compileSafePattern accepts spec.match without throwing`, () => {
      expect(() => compileSafePattern(rule.spec.kind === "pattern" ? rule.spec.match : "")).not.toThrow();
    });
  }
});

describe("LEXICON_FIXTURES", () => {
  it("has exactly one fixture pair per seeded rule, no more, no fewer", () => {
    expect(Object.keys(LEXICON_FIXTURES).sort()).toEqual(
      LEXICON_RULES.map((r) => r.slug).sort(),
    );
  });

  for (const rule of LEXICON_RULES) {
    describe(rule.slug, () => {
      const pair = LEXICON_FIXTURES[rule.slug];

      it("has a firing invoice that parses as a valid InvoiceCanonical", () => {
        expect(() => InvoiceCanonical.parse(pair!.fires.invoice)).not.toThrow();
        if (pair!.fires.previous) {
          expect(() => InvoiceCanonical.parse(pair!.fires.previous)).not.toThrow();
        }
      });

      it("has a non-firing (clean) invoice that parses as a valid InvoiceCanonical", () => {
        expect(() => InvoiceCanonical.parse(pair!.clean.invoice)).not.toThrow();
        if (pair!.clean.previous) {
          expect(() => InvoiceCanonical.parse(pair!.clean.previous)).not.toThrow();
        }
      });

      it("the firing and clean invoices are meaningfully different", () => {
        expect(JSON.stringify(pair!.fires)).not.toBe(JSON.stringify(pair!.clean));
      });
    });
  }
});

describe("pattern.match correctness against the real normalizeDescription + compileSafePattern " +
  "(RF-122) — proves the lexicon strings actually match what CLAUDE.md §7 confirmed, not just that " +
  "they compile", () => {
  function matcherFor(slug: string): RegExp {
    const rule = LEXICON_RULES.find((r) => r.slug === slug)!;
    if (rule.spec.kind !== "pattern") throw new Error(`${slug} is not a pattern rule`);
    return compileSafePattern(rule.spec.match);
  }

  it("RN-020 matches the Vivo package line CLAUDE.md finding #1 is about, plus a plain item hit, " +
    "and does not match an ordinary plan line", () => {
    const re = matcherFor(RN_020);
    expect(re.test(normalizeDescription("Serviços Digitais III"))).toBe(true);
    expect(re.test(normalizeDescription("Skeelo Premium"))).toBe(true);
    expect(re.test(normalizeDescription("Cobrança de Serviços de Terceiro(s)"))).toBe(true);
    expect(re.test(normalizeDescription("Plano Vivo Turbo 5G"))).toBe(false);
  });

  it("RN-021 matches the confirmed insurance lexicon and does not match an ordinary purchase", () => {
    const re = matcherFor(RN_021);
    expect(re.test(normalizeDescription("MP*Chubbsegurosbrasi"))).toBe(true);
    expect(re.test(normalizeDescription("Seguro Cartão Protegido"))).toBe(true);
    expect(re.test(normalizeDescription("Compras do período"))).toBe(false);
  });

  it("RN-023 matches confirmed processor prefixes and does not false-positive on everyday words that " +
    "happen to contain a short prefix as a substring", () => {
    const re = matcherFor(RN_023);
    expect(re.test(normalizeDescription("MP*Chubbsegurosbrasi"))).toBe(true);
    expect(re.test(normalizeDescription("HTM*Curso Online Anual"))).toBe(true);
    expect(re.test(normalizeDescription("PAG*Netflix"))).toBe(true);
    // False-positive guards: "COMPRA" and "PAGAMENTO" both contain "MP"/"PAG"
    // as a bare substring — the word-boundary lookarounds in RN_023_MATCH
    // exist specifically so these do not fire.
    expect(re.test(normalizeDescription("Compra no supermercado"))).toBe(false);
    expect(re.test(normalizeDescription("Pagamento de fatura"))).toBe(false);
    // Confirmed-absent processors (CLAUDE.md §7.2's own negative finding):
    // no stable prefix, so nothing here should ever be built to match them.
    expect(re.test(normalizeDescription("Iugu Assinaturas"))).toBe(false);
    expect(re.test(normalizeDescription("Vindi Recorrencia"))).toBe(false);
  });
});

describe("RN-021's confirm fallback, exercised directly against the confirm evaluator shape it will " +
  "run under (RuleEngineInput's rules[] shape) — see engine.test.ts/confirm.test.ts for the evaluator " +
  "itself, already covered there", () => {
  it("the seeded spec asks a question phrased so a \"Não\" answer means the user disputes the charge " +
    "(confirm.ts's own requirement)", () => {
    const rule = LEXICON_RULES.find((r) => r.slug === RN_021_CONFIRM)!;
    expect(rule.spec.kind).toBe("confirm");
    if (rule.spec.kind === "confirm") {
      expect(rule.spec.onNo).toBe("create_finding");
      expect(rule.spec.options.map((o) => o.toLowerCase())).toContain("não".toLowerCase());
    }
  });
});

describe("end-to-end evaluation against runRules", () => {
  // As of this test, `runRules` (packages/core/src/rules/engine.ts) is still
  // the RF-120 boundary stub that throws for any non-empty rule set — Task 4
  // of this same E2 block (the dispatcher wiring `spec.kind` to the right
  // evaluator) has not landed on this branch yet, even though the
  // individual evaluator functions (pattern/confirm) already exist and are
  // unit-tested in packages/core. So none of RN-020/021(pattern)/021(confirm)
  // /023 can be exercised through the real, wired `runRules` path today —
  // exactly like deterministic.test.ts's own equivalent test for RN-001..011.
  //
  // `pattern`/`confirm` are also not reachable directly from this package:
  // `@pentefino/core`'s package.json only exposes its top-level index and
  // `./ports` (no `./rules/evaluators/*` subpath), so a cross-package direct
  // call to the evaluator functions themselves is not possible from here
  // either. What packages/db *can* prove today about pattern.match, done
  // above, is the actual match-string correctness against the exported
  // `normalizeDescription` + `compileSafePattern` — the two symbols the
  // module's own `pattern.ts` uses to do exactly this.
  it("runs the lexicon rules through the real engine and fires RN-020", () => {
    const activeRules: ActiveRule[] = LEXICON_RULES.map((r) => ({
      slug: r.slug,
      category: r.category,
      version: 1,
      spec: r.spec,
      confidenceBase: r.confidenceBase,
      shadow: true,
      legalBasis: r.legalBasis,
      issuerId: null,
    }));
    const { invoice, previous } = LEXICON_FIXTURES[RN_020]!.fires;

    // This assertion used to pin the engine's not-implemented stub. The
    // engine is implemented now, so it pins the real thing instead: the
    // seeded lexicon rules, run over the fixture that should trip RN-020,
    // actually produce a finding. A rule that seeds cleanly and never fires
    // is the failure this catches.
    const findings = runRules({
      invoice,
      previous,
      rules: activeRules,
      answers: {},
      references: { tariffs: [], flags: [] },
    });

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.legalBasis.length).toBeGreaterThan(0);
    }
  });

  it("produces nothing for the fixture that should not trip RN-020", () => {
    const activeRules: ActiveRule[] = LEXICON_RULES.map((r) => ({
      slug: r.slug,
      category: r.category,
      version: 1,
      spec: r.spec,
      confidenceBase: r.confidenceBase,
      shadow: true,
      legalBasis: r.legalBasis,
      issuerId: null,
    }));
    const { invoice, previous } = LEXICON_FIXTURES[RN_020]!.clean;

    expect(
      runRules({
        invoice,
        previous,
        rules: activeRules,
        answers: {},
        references: { tariffs: [], flags: [] },
      }),
    ).toEqual([]);
  });
});
