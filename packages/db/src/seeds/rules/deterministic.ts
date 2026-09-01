import { sql } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { Category, LegalRef, RuleSpec } from "@pentefino/core";
import { rules } from "../../schema.js";
import type { Database } from "../../client.js";

/**
 * The deterministic rules of PRD §12.1, seeded as versioned `rules` rows
 * (RF-121). Every one of these is specified in the PRD — formula and legal
 * citation both — so nothing here is invented business logic; this file
 * turns §12.1's prose into `RuleSpec` shapes the evaluators in
 * `packages/core/src/rules/evaluators/` can actually run, plus the metadata
 * the `rules` table needs (category, confidence, author, reason).
 *
 * RF-125: a new rule is born `draft` and only enters `shadow` on activation.
 * These rules skip `draft` (there is no admin step to activate them through —
 * they arrive as code, reviewed like any other change) but still land in
 * `shadow`, never `active`: none of them has ever run against a real invoice,
 * and the §1.4 false-positive guardrail and RF-126's auto-promotion exist
 * precisely to gate that transition on evidence this seed cannot supply.
 *
 * ---
 *
 * ## Eleven rules, thirteen rows
 *
 * §12.1 numbers eleven rules, but two of them are disjunctions no evaluator
 * can express as a single row, because none of them has a boolean "or" (see
 * the expression language's own doc comment in
 * `packages/core/src/rules/evaluators/expression.ts`). Splitting them into
 * independent rows is the honest translation — each row is separately true
 * or false, separately citable, and separately promotable by RF-126:
 *
 *   - **RN-004** → {@link RN_004_CONSISTENCIA} and {@link RN_004_RETROCESSO}.
 *   - **RN-010** → {@link RN_010_SAQUES} and {@link RN_010_EXTRATOS}.
 *
 * Both keep their parent RN's legal citation, and `reason` names the parent
 * so a finding still traces back to a numbered PRD rule.
 *
 * ## Why these specs are written against section names
 *
 * `threshold.expr` and `arithmetic.formula`/`expect` are evaluated by a
 * closed, arithmetic-only interpreter over a fixed field list plus
 * `sectionTotal("…")` / `sectionCount("…")`, which aggregate over
 * `InvoiceCanonical` **sections** — not over item tags. There is no way for
 * a rule to say "the items in this section whose description looks like a
 * fine": picking items out by content is `pattern`'s job and deliberately
 * not duplicated in the expression language.
 *
 * So every concept a rule has to weigh on its own (the fine, COSIP,
 * accessory services, the principal, the charges, the withdrawals, …) must
 * arrive as its **own named section** of the canonical invoice. That is a
 * real requirement this seed places on extraction, not a fixture
 * convenience: {@link SECTION} is the vocabulary, and
 * `deterministic.fixtures.ts` is the worked example of an invoice shaped to
 * satisfy it.
 *
 * **A misspelt section name fails silently.** An unknown *field* name throws
 * when the rule is parsed (a defect true on every invoice it would ever
 * run against), but an unknown *section* name is ordinary missing data —
 * `sectionTotal` returns `undefined` and the rule simply never fires, ever,
 * with no error anywhere. That asymmetry is why the specs below interpolate
 * {@link SECTION} instead of repeating string literals: spec and fixture
 * cannot drift apart without a TypeScript error.
 *
 * The same property has a consequence worth stating plainly: **a rule whose
 * section is absent from a real invoice is inert, not satisfied.** RN-001 on
 * an invoice with no COSIP line produces nothing at all — it does not
 * conclude the fine was lawful. That is the intended failure direction
 * (never accuse from a gap in the data), but it means these rules' shadow
 * statistics will under-count rather than over-count.
 *
 * ## The `min(charged, cap)` shape for a ceiling
 *
 * Three rules here are ceilings ("must not exceed X"). `arithmetic` fires
 * when `formula` and `expect` disagree by more than a tolerance, so a
 * ceiling is written as `formula = <charged>`, `expect = min(<charged>,
 * <cap>)`:
 *
 *   - within the cap, `expect` collapses to `formula` itself and the rule
 *     cannot fire, whatever the charge is;
 *   - above it, `expect` is the cap and `formula - expect` is exactly the
 *     overcharge — which is what RN-001's acceptance criterion asks for
 *     ("achado com valor exato da diferença").
 *
 * ## What §12.1 asks for and this seed cannot deliver
 *
 * Recorded here rather than in a tracker because each one changes what a
 * rule *means*, and a reader of these specs needs it in front of them.
 *
 * - **No preconditions.** The expression language has no `if`. RN-003's
 *   "não cabe se o ciclo teve menos de 27 dias" and RN-007's "dívidas
 *   originadas a partir de 01/01/2024" are both gates on whether the rule
 *   applies at all, and neither can be written inside a formula. Both rules
 *   are therefore seeded *ungated* and will fire on cycles the PRD exempts.
 *   A gate belongs before the engine selects the rule (RF-123's selection
 *   step), which no task has built yet — until then `shadow` status is what
 *   contains the false positives.
 * - **No payment history, no account type, no connection phase.** RN-006
 *   needs to know cycle N−1 was paid in full and on time (ledger data,
 *   absent from `InvoiceCanonical` and from the `invoices` table); RN-010's
 *   savings-account variant needs the account type; RN-003's 30/50/100 kWh
 *   minimum needs the connection phase. None of the three facts is modelled
 *   anywhere in the system today.
 * - **One cycle of history, not many.** `EvaluationContext` carries a single
 *   `previous` invoice, so RN-005's "ciclos estimados" (plural) can never be
 *   seen as a run.
 * - **RN-004's third disjunct is unrepresentable.** §12.1 distinguishes
 *   `Consumo-FAT` (billed) from `Consumo-MED` (measured);
 *   `InvoiceCanonical.readings` carries a single `m3`, so the two cannot be
 *   compared at all. {@link RN_004_CONSISTENCIA} covers the first disjunct,
 *   which catches the same overbilling whenever the meter delta is
 *   trustworthy.
 * - **Two rules are questions, not calculations.** RN-005 and RN-006 both
 *   turn on a fact no evaluator can read (see above). Rather than seed a
 *   formula that means something narrower than the rule and quietly accuse
 *   people on it, both are seeded as `confirm` — RF-124's mechanism for
 *   exactly this: ask the user instead of guessing. Both questions are
 *   phrased so "Não" means the user disputes the charge, which is the
 *   contract `confirm` documents for `onNo`.
 * - **A `confirm` rule cannot gate itself either.** RN-005's question is
 *   only meaningful when the previous cycle was estimated and this one was
 *   not, and `confirm` has no way to check that — it asks on every water
 *   invoice it is run against. Same for RN-006 on every card invoice.
 * - **Three thresholds count, and findings measure money.** RN-002, RN-009
 *   and both halves of RN-010 trigger on a *count* of items, so the
 *   `amountCents` the `threshold` evaluator derives from `expr` is that
 *   count, not a sum in cents. `threshold.ts` documents this rough edge and
 *   says it must be resolved where the rule is seeded — but `RuleSpec` has
 *   no field to carry an amount separate from the compared expression, so it
 *   cannot be resolved here either. Whatever consumes these findings must
 *   not read their `amountCents` as money.
 * - **RN-011 has nothing to compare against on a real invoice.** A bank
 *   statement prints the package price, never the individual tariffs it
 *   replaces; those live in the issuer's published tariff schedule. Until
 *   that reference data exists, this rule is inert outside its fixture.
 * - **RN-002 and RN-009 depend on how the issuer itemises.** Both count
 *   items in a section, so both assume the extractor emits one item per
 *   covered cycle / per charge. An issuer that collapses four cycles of
 *   adjustment into a single line is invisible to RN-002.
 * - **RN-009's 30-day window is approximated by the billing cycle.** The
 *   expression language cannot reach `item.periodRef`, so "mais de uma
 *   cobrança em 30 dias" is read as "more than one on this invoice". Two
 *   charges 20 days apart that straddle two invoices are missed.
 * - **RN-008 through RN-011 are bank-tariff rules** (Res. CMN 3.919/2010,
 *   Circular BCB 3.466/2009), not credit-card rules, but `rules.category`'s
 *   CHECK constraint only knows `telecom|card|energy|water` — there is no
 *   `bank` category. They are filed under `card` as the closest bucket, same
 *   as RN-006/007.
 */

/**
 * The `InvoiceCanonical` section names these rules aggregate over. Shared
 * with `deterministic.fixtures.ts` so a rename cannot silently turn a rule
 * inert — see the header on why a wrong section name produces no error at
 * all.
 */
export const SECTION = {
  consumoEnergia: "Consumo de Energia",
  cosip: "COSIP",
  servicosAcessorios: "Serviços Acessórios",
  multasAnteriores: "Multas Anteriores",
  multa: "Multa",
  acertoFaturamento: "Acerto de Faturamento",
  custoDisponibilidade: "Custo de Disponibilidade",
  principal: "Principal",
  encargos: "Encargos",
  iof: "IOF",
  avaliacaoCredito: "Avaliação Emergencial de Crédito",
  saques: "Saques",
  extratos: "Extratos",
  pacoteServicos: "Pacote de Serviços",
  tarifasIndividuais: "Tarifas Individuais Equivalentes",
  tarifas: "Tarifas",
} as const;

export const RN_001 = "rn-001-multa-base-energia";
export const RN_002 = "rn-002-acerto-faturamento-energia";
export const RN_003 = "rn-003-custo-disponibilidade";
export const RN_004_CONSISTENCIA = "rn-004-leitura-agua-consistencia";
export const RN_004_RETROCESSO = "rn-004-leitura-agua-retrocesso";
export const RN_005 = "rn-005-media-sem-acerto-agua";
export const RN_006 = "rn-006-encargo-fatura-paga";
export const RN_007 = "rn-007-teto-cartao";
export const RN_008 = "rn-008-renovacao-cadastral";
export const RN_009 = "rn-009-avaliacao-emergencial-credito";
export const RN_010_SAQUES = "rn-010-saques-conta-corrente";
export const RN_010_EXTRATOS = "rn-010-extratos";
export const RN_011 = "rn-011-pacote-servicos";

const AUTHOR = "prd-12.1";

type DeterministicRule = {
  slug: string;
  category: Category;
  spec: RuleSpec;
  legalBasis: LegalRef[];
  confidenceBase: number;
  reason: string;
};

/**
 * RN-001's lawful base: the invoice total stripped of COSIP, accessory
 * services and prior penalties — and of the fine itself, which §12.1's
 * "total − COSIP − serviços − multas anteriores" leaves in only because it
 * reads "total" as the pre-fine amount. Leaving the current fine inside its
 * own base would let a fine accrue on itself.
 *
 * Written as `* 2 / 100` rather than `* 0.02`: 0.02 has no exact binary
 * representation, and `30000 * 0.02` is 600.0000000000001 in JS, while
 * `30000 * 2 / 100` is exactly 600. The evaluators go to some length to
 * keep a float from deciding a monetary yes/no (see `delta.ts` and
 * `reference.ts`); a rule string should not undo that.
 */
const RN_001_BASE =
  `(total - sectionTotal("${SECTION.cosip}") - sectionTotal("${SECTION.servicosAcessorios}")` +
  ` - sectionTotal("${SECTION.multasAnteriores}") - sectionTotal("${SECTION.multa}"))`;

export const DETERMINISTIC_RULES: readonly DeterministicRule[] = [
  {
    slug: RN_001,
    category: "energy",
    spec: {
      kind: "arithmetic",
      formula: `sectionTotal("${SECTION.multa}")`,
      expect: `min(sectionTotal("${SECTION.multa}"), ${RN_001_BASE} * 2 / 100)`,
      // 1% of the cap, to absorb the utility's own rounding rather than
      // accuse over a centavo. Far below the smallest overcharge a wrong
      // base can produce: pulling COSIP alone into the base moves the cap
      // by much more than 1%.
      tolerancePct: 1,
    },
    legalBasis: [{
      law: "REN 1.000/2021",
      article: "art. 343, §2º",
      effect: "limite",
      note: "Multa recalculada sem COSIP, serviços acessórios e multas anteriores; teto de 2%, juros até 1% a.m. pro rata die, correção por IPCA.",
    }],
    confidenceBase: 0.95,
    reason: "RN-001 (PRD §12.1): a multa em energia não pode incidir sobre COSIP, serviços acessórios ou multas anteriores.",
  },
  {
    slug: RN_002,
    category: "energy",
    // One item per cycle the adjustment covers; see the header on what that
    // assumes about extraction.
    spec: {
      kind: "threshold",
      expr: `sectionCount("${SECTION.acertoFaturamento}")`,
      operator: ">",
      value: 3,
    },
    legalBasis: [{
      law: "REN 1.000/2021",
      article: "art. 324",
      effect: "vedada",
      note: "Rubrica de acerto de faturamento cobrindo mais de 3 ciclos é indevida.",
    }],
    confidenceBase: 0.93,
    reason: "RN-002 (PRD §12.1): rubrica de acerto de faturamento cobrindo mais de 3 ciclos é indevida.",
  },
  {
    slug: RN_003,
    category: "energy",
    /**
     * "É o maior entre mínimo e consumo, **nunca a soma**" — and the sum is
     * exactly what an invoice charging both a consumption line and an
     * availability line in the same cycle is doing. `min(a, b) > 0` says
     * "both of these are positive", and the smaller of the two is precisely
     * the amount that should not have been charged, which is what
     * `threshold` reports as the finding's value.
     *
     * This is the one form of RN-003 the expression language can carry. The
     * alternative — comparing the billed availability *quantity* against
     * `max(minimum, kwh)` — needs `item.qty`, which no aggregate can reach
     * (only `sectionTotal`/`sectionCount` exist, working in cents and
     * counts), and needs the connection phase to choose 30/50/100. Neither
     * is available, so the quantity check is not seeded at all rather than
     * approximated. Splitting this rule per phase would not help: the phase
     * only chooses the minimum, and the minimum only matters to the quantity
     * check this rule does not perform.
     *
     * What that costs: an invoice charging availability alone but computing
     * it as the sum (40 kWh instead of max(30, 10)) passes, since only one
     * section carries a charge. What it catches — both lines present — is
     * the abuse §12.1 names, and it catches it without needing a single fact
     * the invoice does not carry.
     */
    spec: {
      kind: "threshold",
      expr:
        `min(sectionTotal("${SECTION.consumoEnergia}"), sectionTotal("${SECTION.custoDisponibilidade}"))`,
      operator: ">",
      value: 0,
    },
    legalBasis: [{
      law: "REN 1.000/2021",
      article: "art. 655-I",
      effect: "limite",
      note: "Custo de disponibilidade é o maior entre mínimo (30/50/100 kWh conforme a fase) e consumo, nunca a soma; não cabe em ciclo com menos de 27 dias.",
    }],
    confidenceBase: 0.95,
    reason: "RN-003 (PRD §12.1): custo de disponibilidade é o maior entre mínimo e consumo, nunca a soma.",
  },
  {
    slug: RN_004_CONSISTENCIA,
    category: "water",
    // §12.1's first disjunct: `leituraAtual − leituraAnterior ≠ consumo`.
    // `m3` is the consumption the invoice states; the readings are what the
    // meter showed. Zero tolerance — a water meter's arithmetic either
    // closes or it does not.
    spec: {
      kind: "arithmetic",
      formula: "readingsCurrent - readingsPrevious",
      expect: "m3",
      tolerancePct: 0,
    },
    legalBasis: [
      { law: "Aritmética", article: "leitura atual − leitura anterior deve igualar o consumo faturado", effect: "vedada" },
      { law: "NR 11/ANA/2024", article: "regras de leitura e faturamento (PRD não cita artigo específico)", effect: "vedada" },
    ],
    confidenceBase: 0.95,
    reason: "RN-004 (PRD §12.1), primeira hipótese: leitura de água inconsistente com o consumo faturado.",
  },
  {
    slug: RN_004_RETROCESSO,
    category: "water",
    // §12.1's second disjunct: "atual < anterior sem troca de hidrômetro".
    // The exception cannot be expressed — the expression language has no
    // conditional, and nothing here reads a meter-swap line — so a genuine
    // meter replacement fires this rule. Confidence sits below its sibling's
    // to reflect that, and `shadow` keeps it away from users until the
    // numbers say otherwise.
    spec: {
      kind: "threshold",
      expr: "readingsCurrent - readingsPrevious",
      operator: "<",
      value: 0,
    },
    legalBasis: [
      { law: "Aritmética", article: "leitura atual não pode ser menor que a anterior sem troca de hidrômetro", effect: "vedada" },
      { law: "NR 11/ANA/2024", article: "regras de leitura e faturamento (PRD não cita artigo específico)", effect: "vedada" },
    ],
    confidenceBase: 0.75,
    reason: "RN-004 (PRD §12.1), segunda hipótese: leitura atual menor que a anterior, sem troca de hidrômetro.",
  },
  {
    slug: RN_005,
    category: "water",
    // A calculation would need `readings.estimated` on both invoices and a
    // check that an adjustment line is *absent* — no evaluator has either
    // (`delta` only reports items that appeared, never ones that failed to).
    // So: ask. "Não" means the acerto is missing, which is the finding.
    spec: {
      kind: "confirm",
      question:
        "Sua conta anterior foi cobrada por média e esta veio com leitura real. O acerto entre as duas apareceu nesta fatura?",
      options: ["Sim", "Não", "Não sei"],
      onNo: "create_finding",
    },
    legalBasis: [{
      law: "NR 11/ANA/2024",
      article: "regras de leitura e faturamento (PRD não cita artigo específico)",
      effect: "vedada",
      note: "Ciclo estimado seguido de leitura real exige lançamento de ajuste.",
    }],
    confidenceBase: 0.80,
    reason: "RN-005 (PRD §12.1): ciclo estimado seguido de leitura real sem lançamento de ajuste.",
  },
  {
    slug: RN_006,
    category: "card",
    // Whether cycle N−1 was paid in full and on time is ledger data the
    // system does not hold, and no evaluator can read it. The question is
    // phrased so "Não" means the user disputes the charge, as `confirm`
    // requires — never "você pagou?", whose "Não" would mean the opposite.
    spec: {
      kind: "confirm",
      question:
        "Esta fatura cobra juros, mora ou rotativo. Se você pagou a fatura anterior integralmente e até o vencimento, essa cobrança está correta?",
      options: ["Sim", "Não", "Não sei"],
      onNo: "create_finding",
    },
    legalBasis: [
      { law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" },
      { law: "STJ", article: "Tema 929", effect: "vedada" },
    ],
    confidenceBase: 0.60,
    reason: "RN-006 (PRD §12.1): juros, mora ou rotativo no ciclo N com pagamento integral e tempestivo no ciclo N-1.",
  },
  {
    slug: RN_007,
    category: "card",
    // Encargos (juros + mora + rotativo + parcelamento) capped at the
    // principal. IOF is excluded by §12.1 and therefore lives in its own
    // section, outside the sum. The 01/01/2024 cutoff is a gate on whether
    // the rule applies and cannot be written here — see the header.
    spec: {
      kind: "arithmetic",
      formula: `sectionTotal("${SECTION.encargos}")`,
      expect: `min(sectionTotal("${SECTION.encargos}"), sectionTotal("${SECTION.principal}"))`,
      tolerancePct: 0,
    },
    legalBasis: [
      { law: "Lei 14.690/2023", article: "teto de 100% sobre o principal para dívidas originadas a partir de 01/01/2024", effect: "limite" },
      { law: "Res. CMN 5.112/2023", article: "regulamentação do teto do rotativo do cartão de crédito", effect: "limite" },
    ],
    confidenceBase: 0.90,
    reason: "RN-007 (PRD §12.1): soma de juros, mora, rotativo e parcelamento (exceto IOF) maior que o principal, para dívidas originadas a partir de 01/01/2024.",
  },
  {
    slug: RN_008,
    category: "card",
    // The one §12.1 rule that is a pure description match, and the only spec
    // that survived Task 5 unchanged. `match` is a RegExp source run against
    // `normalizeDescription(item.description)` — already uppercased and
    // accent-stripped, so "Renovação" arrives as "RENOVACAO".
    spec: {
      kind: "pattern",
      match: "RENOVACAO (DE )?CADASTRO",
    },
    legalBasis: [{
      law: "Circular BCB 3.466/2009",
      article: "vedação à tarifa de renovação de cadastro",
      effect: "vedada",
    }],
    confidenceBase: 0.97,
    reason: "RN-008 (PRD §12.1): qualquer cobrança de tarifa de renovação de cadastro é vedada.",
  },
  {
    slug: RN_009,
    category: "card",
    // "Mais de uma cobrança em 30 dias", read as "more than one on this
    // invoice" — see the header on the window and on itemisation.
    spec: {
      kind: "threshold",
      expr: `sectionCount("${SECTION.avaliacaoCredito}")`,
      operator: ">",
      value: 1,
    },
    legalBasis: [{
      law: "Res. CMN 3.919/2010",
      article: "tarifa de avaliação emergencial de crédito — no máximo uma cobrança a cada 30 dias",
      effect: "limite",
    }],
    confidenceBase: 0.85,
    reason: "RN-009 (PRD §12.1): mais de uma cobrança de avaliação emergencial de crédito em 30 dias.",
  },
  {
    slug: RN_010_SAQUES,
    category: "card",
    /**
     * §12.1 allows 4 withdrawals a month on a conta corrente and 2 on a
     * poupança. `InvoiceCanonical` records no account type, so only the
     * conta-corrente limit is seeded: it is the looser of the two, and
     * seeding the poupança limit as well would fire on the 3rd and 4th
     * lawful withdrawal of every checking account. Missing a poupança
     * overcharge is a false negative; flagging a lawful withdrawal is a
     * false positive in the user's name. §1.4's guardrail settles which of
     * those to prefer.
     */
    spec: {
      kind: "threshold",
      expr: `sectionCount("${SECTION.saques}")`,
      operator: ">",
      value: 4,
    },
    legalBasis: [{
      law: "Res. CMN 3.919/2010",
      article: "serviços essenciais gratuitos — quantidades mínimas de saques",
      effect: "limite",
    }],
    confidenceBase: 0.92,
    reason: "RN-010 (PRD §12.1), saques: mais de 4 saques cobrados no mês em conta corrente.",
  },
  {
    slug: RN_010_EXTRATOS,
    category: "card",
    // The statement limit is 2 a month for both account types, so this half
    // of RN-010 needs no account type and is seeded whole.
    spec: {
      kind: "threshold",
      expr: `sectionCount("${SECTION.extratos}")`,
      operator: ">",
      value: 2,
    },
    legalBasis: [{
      law: "Res. CMN 3.919/2010",
      article: "serviços essenciais gratuitos — quantidades mínimas de extratos",
      effect: "limite",
    }],
    confidenceBase: 0.92,
    reason: "RN-010 (PRD §12.1), extratos: mais de 2 extratos cobrados no mês.",
  },
  {
    slug: RN_011,
    category: "card",
    // Inert on a real statement until the issuer's tariff schedule is
    // imported — see the header. The fixture carries both sections so the
    // arithmetic itself is proven.
    spec: {
      kind: "arithmetic",
      formula: `sectionTotal("${SECTION.pacoteServicos}")`,
      expect:
        `min(sectionTotal("${SECTION.pacoteServicos}"), sectionTotal("${SECTION.tarifasIndividuais}"))`,
      tolerancePct: 0,
    },
    legalBasis: [{
      law: "Res. CMN 3.919/2010",
      article: "art. 6º",
      effect: "limite",
      note: "Pacote de serviços não pode custar mais que a soma das tarifas individuais que substitui.",
    }],
    confidenceBase: 0.93,
    reason: "RN-011 (PRD §12.1): pacote de serviços custando mais que a soma das tarifas individuais que substitui.",
  },
];

/**
 * Seeds the rules above as `shadow`, versioned `rules` rows.
 *
 * On conflict (redeploy re-running the seed), only the rule's *content* is
 * refreshed — spec, legal basis, confidence, category, reason. `status` and
 * `shadowUntil` are deliberately left untouched, the same way `issuers.ts`
 * leaves `status` alone on conflict: RF-126/127 move a rule between
 * shadow/active/paused based on real firing data, and a reseed must not
 * silently undo that promotion or pause.
 */
export async function seedDeterministicRules(db: Database): Promise<void> {
  const shadowUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  for (const entry of DETERMINISTIC_RULES) {
    await db
      .insert(rules)
      .values({
        id: newId("rul"),
        slug: entry.slug,
        version: 1,
        category: entry.category,
        issuerId: null,
        kind: entry.spec.kind,
        spec: entry.spec,
        legalBasis: entry.legalBasis,
        confidenceBase: entry.confidenceBase,
        status: "shadow",
        shadowUntil,
        author: AUTHOR,
        reason: entry.reason,
      })
      .onConflictDoUpdate({
        target: [rules.slug, rules.version],
        set: {
          category: entry.category,
          kind: entry.spec.kind,
          spec: entry.spec,
          legalBasis: entry.legalBasis,
          confidenceBase: entry.confidenceBase,
          reason: entry.reason,
          updatedAt: sql`now()`,
        },
      });
  }
}
