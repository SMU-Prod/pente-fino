import { sql } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { Category, LegalRef, RuleSpec } from "@pentefino/core";
import { rules } from "../../schema.js";
import type { Database } from "../../client.js";

/**
 * The eleven deterministic rules of PRD §12.1, seeded as versioned `rules`
 * rows (RF-121). Every one of these is fully specified in the PRD — formula
 * and legal citation both — so nothing here is invented business logic; this
 * file only turns §12.1's prose into `RuleSpec` shapes plus the metadata the
 * `rules` table needs (category, confidence, author, reason).
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
 * ## A provisional expression notation
 *
 * `RuleSpec`'s `arithmetic` (`formula`/`expect`) and `threshold` (`expr`)
 * variants hold free-form strings — RF-121's six evaluators are E2's to
 * build (Tasks 1/2 of this block, running in parallel with this one), and as
 * of this seed none of them exist yet (`runRules` is still the RF-120
 * boundary stub that throws for any non-empty rule set — see
 * `packages/core/src/rules/engine.ts`). There is therefore no real grammar
 * yet to conform to. The notation below is this seed's best-effort proposal
 * for that grammar, applied consistently across all eleven rules so a future
 * evaluator has one convention to implement rather than eleven ad hoc ones —
 * but it is a proposal, not a contract, and may need to change once Tasks
 * 1/2 land their real interpreter.
 *
 *   - `invoice.<path>` / `previous.<path>` — a field of `InvoiceCanonical`
 *     (the current or previous invoice); `readings.<path>` is shorthand for
 *     `invoice.readings.<path>`.
 *   - `item('role')` — the single invoice item whose `meta.role` equals
 *     `'role'`. `items('role', ...)` — the array of items whose `meta.role`
 *     is any of the given roles; `.sumCents` sums their `amountCents` (0 if
 *     none match), `.qty` reads the single matched item's `qty`.
 *   - `exists('role')` — whether any item carries that `meta.role`.
 *   - `count(item matches '<pattern>')` — how many items' (normalized, per
 *     RF-122) descriptions match the pattern.
 *   - `min(a, b)`, `max(a, b)`, ternary `cond ? a : b` — arithmetic and
 *     branching, standard meaning.
 *
 * For a one-sided cap ("must not exceed X"), `expect` is written as
 * `min(formula, X)`: when the charge is within the cap, `expect` collapses
 * to `formula` itself (no mismatch, whatever the charge is); when it isn't,
 * `expect` is the cap and `formula - expect` is exactly the overcharge —
 * which is what RN-001's acceptance criterion asks for ("achado com valor
 * exato da diferença"). The same trick guards a rule that only applies under
 * some precondition (RN-003's 27-day cycle floor, RN-007's 2024 cutoff):
 * the guard is folded into `expect` as `guard ? formula : <real check>`, so
 * outside the guarded window `expect` always equals `formula` and the rule
 * is structurally inert rather than needing a separate "applies" field that
 * `RuleSpec` has no room for.
 *
 * For a rule that is really a disjunction of conditions (RN-004, RN-005,
 * RN-006, RN-010 each combine several independent triggers with "or"),
 * `formula` is instead a boolean expression and `expect` is the literal
 * string `"false"` — an anomaly fires the rule, no anomaly doesn't.
 * `tolerancePct` is meaningless for a boolean pair and is set to 0.
 *
 * See `deterministic.fixtures.ts` for the `meta.role` values each rule's
 * fixtures populate — that file is the concrete contract for this notation
 * until a real evaluator supersedes it.
 *
 * ## Known gaps this seed cannot close
 *
 * - **RN-006** fires on "juros/mora/rotativo charged in cycle N given cycle
 *   N−1 was paid in full and on time" — but *payment status* is ledger data,
 *   not invoice content, and nothing in `InvoiceCanonical` or the `invoices`
 *   table records it. This seed proxies "paid in full and on time" as "the
 *   previous invoice itself carried no juros/mora/rotativo charges", which
 *   is not the same claim (a customer can pay late without the *next*
 *   invoice showing interest, if the issuer waives it) — hence this rule's
 *   low `confidenceBase` relative to its siblings.
 * - **RN-005** ("ciclos estimados", plural) can only be checked one cycle
 *   back: `RuleEngineInput` carries a single `previous` invoice, not a
 *   history, so a run of more than one estimated cycle is invisible to it.
 * - **RN-007**'s cutoff is about when the underlying *debt* originated,
 *   which can predate the invoice that finally bills it (e.g. a rolled-over
 *   installment). This seed uses the invoice's own `period.start` as a
 *   stand-in, which is exact for a debt that originates and bills in the
 *   same cycle and approximate otherwise.
 * - **RN-008 through RN-011** are bank-tariff rules (Res. CMN 3.919/2010,
 *   Circular BCB 3.466/2009), not credit-card rules, but `rules.category`'s
 *   CHECK constraint only knows `telecom|card|energy|water` — there is no
 *   `bank` category distinct from `card`. They are filed under `card` as the
 *   closest existing bucket, same as RN-006/007.
 */

export const RN_001 = "rn-001-multa-base-energia";
export const RN_002 = "rn-002-acerto-faturamento-energia";
export const RN_003 = "rn-003-custo-disponibilidade";
export const RN_004 = "rn-004-leitura-agua";
export const RN_005 = "rn-005-media-sem-acerto-agua";
export const RN_006 = "rn-006-encargo-fatura-paga";
export const RN_007 = "rn-007-teto-cartao";
export const RN_008 = "rn-008-renovacao-cadastral";
export const RN_009 = "rn-009-avaliacao-emergencial-credito";
export const RN_010 = "rn-010-servicos-essenciais-gratuitos";
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

export const DETERMINISTIC_RULES: readonly DeterministicRule[] = [
  {
    slug: RN_001,
    category: "energy",
    spec: {
      kind: "arithmetic",
      formula: "items('multa').sumCents",
      expect:
        "min(items('multa').sumCents, 0.02 * (invoice.totalCents - items('cosip').sumCents - items('servico_acessorio').sumCents - items('multa_anterior').sumCents))",
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
    spec: {
      kind: "threshold",
      expr: "item('acerto_faturamento').meta.ciclosCobertos",
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
    spec: {
      kind: "arithmetic",
      formula: "item('disponibilidade').qty",
      expect:
        "readings.days < 27 ? item('disponibilidade').qty : min(item('disponibilidade').qty, max(item('disponibilidade').meta.minimoKwh, readings.kwh))",
      tolerancePct: 0,
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
    slug: RN_004,
    category: "water",
    spec: {
      kind: "arithmetic",
      formula:
        "(readings.current - readings.previous != item('consumo_faturado').qty) || (readings.current < readings.previous && !exists('troca_medidor')) || (item('consumo_faturado').qty > readings.m3 && !exists('ajuste_consumo'))",
      expect: "false",
      tolerancePct: 0,
    },
    legalBasis: [
      { law: "Aritmética", article: "leitura atual − leitura anterior deve igualar o consumo faturado", effect: "vedada" },
      { law: "NR 11/ANA/2024", article: "regras de leitura e faturamento (PRD não cita artigo específico)", effect: "vedada" },
    ],
    confidenceBase: 0.95,
    reason: "RN-004 (PRD §12.1): leitura de água inconsistente com o consumo faturado, queda de leitura sem troca de hidrômetro, ou consumo faturado maior que o medido sem justificativa.",
  },
  {
    slug: RN_005,
    category: "water",
    spec: {
      kind: "arithmetic",
      formula: "previous.readings.estimated && !invoice.readings.estimated && !exists('ajuste_consumo')",
      expect: "false",
      tolerancePct: 0,
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
    spec: {
      kind: "arithmetic",
      formula:
        "items('juros','mora','rotativo').sumCents > 0 && previous.items('juros','mora','rotativo').sumCents == 0",
      expect: "false",
      tolerancePct: 0,
    },
    legalBasis: [
      { law: "CDC", article: "art. 42, parágrafo único", effect: "vedada" },
      { law: "STJ", article: "Tema 929", effect: "vedada" },
    ],
    confidenceBase: 0.60,
    reason: "RN-006 (PRD §12.1): juros, mora ou rotativo no ciclo N com pagamento integral e tempestivo no ciclo N-1.",
  },
  {
    slug: RN_007,
    category: "card",
    spec: {
      kind: "arithmetic",
      formula: "items('juros','mora','rotativo','parcelamento').sumCents",
      expect:
        "invoice.period.start < '2024-01-01' ? items('juros','mora','rotativo','parcelamento').sumCents : min(items('juros','mora','rotativo','parcelamento').sumCents, item('principal').amountCents)",
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
    spec: {
      kind: "threshold",
      expr: "count(item matches 'AVALIACAO (EMERGENCIAL )?DE CREDITO')",
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
    slug: RN_010,
    category: "card",
    spec: {
      kind: "arithmetic",
      formula:
        "(item('resumo_servicos_essenciais').meta.tipoConta == 'corrente' && item('resumo_servicos_essenciais').meta.saques > 4) || (item('resumo_servicos_essenciais').meta.tipoConta == 'poupanca' && item('resumo_servicos_essenciais').meta.saques > 2) || (item('resumo_servicos_essenciais').meta.extratos > 2)",
      expect: "false",
      tolerancePct: 0,
    },
    legalBasis: [{
      law: "Res. CMN 3.919/2010",
      article: "serviços essenciais gratuitos — quantidades mínimas de saques e extratos",
      effect: "limite",
    }],
    confidenceBase: 0.92,
    reason: "RN-010 (PRD §12.1): mais de 4 saques/mês em conta corrente, 2 em poupança, ou mais de 2 extratos/mês.",
  },
  {
    slug: RN_011,
    category: "card",
    spec: {
      kind: "arithmetic",
      formula: "item('pacote').amountCents",
      expect: "min(item('pacote').amountCents, item('pacote').meta.somaTarifasIndividuaisCents)",
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
 * Seeds the eleven rules above as `shadow`, versioned `rules` rows.
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
