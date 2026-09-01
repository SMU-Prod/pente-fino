import { sql } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { Category, LegalRef, RuleSpec } from "@pentefino/core";
import { rules } from "../../schema.js";
import type { Database } from "../../client.js";

/**
 * RN-020, RN-021 and RN-023 of PRD §12.2, seeded as versioned `rules` rows
 * (RF-121), the way `deterministic.ts` seeds §12.1 — same shape, same
 * `shadow`-only landing (RF-125), same idempotent upsert-by-(slug,version).
 *
 * What is different here is the *source* of the vocabulary these three
 * rules match against: CLAUDE.md §7, a lexicon built entirely from
 * complaint text (Reclame Aqui titles, official operator/processor pages,
 * the MP-GO precedent) with **no real invoice in hand** — §7.0 spells out
 * exactly what that does and does not prove. This file only ever pulls a
 * lexicon term across into a `RuleSpec.match` when CLAUDE.md marked it
 * ✅ **confirmed** (2+ independent sources). The ⚠️ single-source and
 * ❔ needs-a-real-invoice entries are left out on purpose — not an oversight,
 * a hypothesis in a live rule is a false accusation waiting for a real
 * person, and §7.0 already spends a paragraph on why that trade favours a
 * missed term over a wrongly-accused one (RF-106).
 *
 * ---
 *
 * ## RN-020 — one row, anchor-scoped, not two confidence tiers
 *
 * PRD §12.2 gives RN-020 two confidence numbers: 0,80 base, 0,88 "quando a
 * seção é a âncora confirmada". This seed only ships the 0,88 row, scoped to
 * `sections` (the SVA/digital-services/third-party section names PRD §20.1
 * already seeds per issuer, in `issuers.ts`). Two reasons, not one:
 *
 * 1. **It is what the lexicon actually confirmed.** Every ✅ item in
 *    CLAUDE.md §7.1.2 lists a "Seção/pacote típico" — the research is about
 *    items found *inside* a named SVA-type section, not items floating
 *    anywhere on the bill. Scoping to those sections is not a weaker rule
 *    reaching for less; it is the honest boundary of what was confirmed.
 * 2. **A second, unscoped 0,80 row would double-fire on the exact case the
 *    lexicon is strongest on.** `RuleSpec.pattern.sections` is
 *    inclusion-only — there is no "match anywhere *except* these sections"
 *    field to give the 0,80 tier a clean, non-overlapping catchment. An
 *    unscoped row using the same `match` would fire a *second*, redundant
 *    finding on every single anchor-section hit the 0,88 row already
 *    caught (e.g. "Skeelo" inside Vivo's "Serviços Digitais"), which is a
 *    worse outcome than not shipping the 0,80 tier at all: a duplicated
 *    achado for one real overcharge, not two independent ones.
 *
 * `match` also folds in `CLAUDE.md`'s finding #1: Vivo bills a package
 * literally named **"Serviços Digitais III"** that sums several SVA items
 * (FunKids, Hube Jornais, Vivo Meditação Lite, ...) into one billed line.
 * A rule that only lists the sub-item names would see one ordinary line
 * where there are really several stacked SVA charges, because the sub-item
 * names never appear as separate line items in that case. "SERVICOS
 * DIGITAIS III" is itself ✅ confirmed (CLAUDE.md §7.1.1: 2 independent
 * Reclame Aqui complaints name the combo directly), so it is matched as its
 * own lexicon entry, not inferred from its parts.
 *
 * ## RN-021 — two rows, because one `RuleSpec` row has one `kind`
 *
 * PRD §12.2: confidence 0,72 when the line matches the insurance lexicon;
 * "se não casar com o léxico mas o padrão bater, vira `confirm`" when it
 * does not. A `RuleSpec` value is exactly one `kind` (`spec.ts`), so this
 * seed ships it as two rows sharing one business rule:
 *
 * - `RN_021` (`pattern`, 0,72): the lexicon-match half — a card-statement
 *   line whose normalised description matches the ✅ insurance lexicon.
 * - `RN_021_CONFIRM` (`confirm`): the residual half. RF-124 already
 *   documents that confidence below 0,55 is never shown as a claim, only
 *   ever as a question — and `confirm` is the one `RuleSpec` kind able to
 *   ask one (`confirm.ts`'s own doc comment: "RF-124's mechanism"). This
 *   row's `confidenceBase` (0,40) is chosen to sit in that band.
 *
 * **What this does not close:** `RuleSpec`'s `confirm` kind has no
 * match/recurrence fields at all — `question`/`options`/`onNo` only. It
 * cannot itself test "this line is recurring, value-stable, under 8% of the
 * total, and does *not* match the insurance lexicon" before asking its
 * question; today it simply asks whenever it is active for an invoice.
 * Wiring that gate is either a richer `confirm` `RuleSpec` (match/recurrence
 * fields of its own) or an upstream step outside `packages/core` that only
 * activates this row when the residual condition holds — neither exists
 * yet. Recorded here rather than solved, the same way `deterministic.ts`
 * records RN-005/006/007's gaps instead of quietly working around them.
 *
 * Neither RN-021 row can enforce the PRD's "valor estável (variação < 5%)"
 * or "abaixo de 8% do total" conditions either: `pattern.spec` only offers
 * `valueRange` (an absolute cents bound) and `requireRecurrence` (binary
 * presence one cycle back, per `pattern.ts`'s own doc comment — never "3+
 * cycles", `EvaluationContext` carries at most one previous invoice). Both
 * rows use `requireRecurrence: 1` as the closest available proxy for "3+
 * ciclos" and leave the value-stability/percentage-of-total checks
 * unenforced — a real gap, not a rounding error, flagged the same way RN-005
 * flags its own single-cycle limit in `deterministic.ts`.
 *
 * ## RN-023 — a classification, seeded carefully around RF-129
 *
 * RN-023's own last sentence: "Não é achado de cobrança indevida por si."
 * `Finding.legalBasis` is mandatory (RF-129) and every existing `LegalRef`
 * in this codebase so far backs an *accusation*. Inventing one here just to
 * satisfy the schema would misrepresent a classification as a legal claim —
 * exactly what the task setting this up warned against. What is used
 * instead is CDC art. 6º, III (the consumer's right to clear, adequate
 * information about a service) with `effect: "cancelamento"`: a citation
 * that is unquestionably real and on-topic (RN-023 exists so the app can
 * show the user where to cancel a service they can now identify) without
 * asserting the charge itself is wrong. `Decreto 11.034/2022` — already
 * cited elsewhere in the PRD (RN-024, art. 14 II, for billing *after*
 * cancellation) — was considered and rejected here on purpose: that
 * article is about a different fact pattern, and no other article of that
 * decree is confirmed anywhere in this repo's PRD/lexicon research, so
 * citing one would be exactly the invented citation this task warned
 * against, not a documented one.
 *
 * `confidenceBase` (0,90) reflects certainty in the *descriptor-prefix
 * match* (a prefix string comparison, not a judgement call), not certainty
 * that anything is wrong — there is nothing to be wrong about. This is a
 * real mismatch with RF-124's display table (0,55-0,8 "verificar", >0,8
 * "provável cobrança a contestar"): both bands assume the finding underneath
 * might be improper, and RN-023 explicitly is not that. No band in RF-124
 * correctly represents "certain, non-accusatory classification" — fixing
 * that is a presentation-layer/schema change (e.g. a way to mark a `Finding`
 * as classification-only) outside what a seed file can do, and is flagged
 * here rather than papered over with a confidence number picked to dodge
 * the display table instead of to describe the match.
 *
 * `match` only lists prefixes CLAUDE.md §7.2 marks ✅ confirmed (Mercado
 * Pago, PagBank, PayPal, Ebanx, dLocal, Hotmart, Appmax). It deliberately
 * excludes Iugu, Vindi, Pagar.me and Asaas — §7.2's own "Negativo
 * confirmado" finding is that these show a per-merchant soft descriptor
 * with no stable platform prefix, so a regex keyed on their names would
 * simply never fire on a real invoice — and the pure acquirers (Cielo,
 * Rede, GetNet), same reason. Short prefixes (`MP`, `PAG`, `PP`, `DL`, `HT`)
 * are wrapped in `(?<![A-Z])...(?![A-Z])` lookarounds so they only match as
 * a whole token — without that, bare "MP" or "PAG" would also match inside
 * ordinary words like "COMPRA", "EMPRESA" or "PAGAMENTO" once normalised.
 * `requireRecurrence: 1` guards against classifying an ordinary one-off
 * purchase processed through one of these processors as a "recurring
 * subscription" — with the same single-cycle-only caveat as RN-021 above.
 */

export const RN_020 = "rn-020-sva-telecom";
export const RN_021 = "rn-021-seguro-embutido-cartao";
export const RN_021_CONFIRM = "rn-021-seguro-embutido-cartao-confirm";
export const RN_023 = "rn-023-assinatura-recorrente-processador";

const AUTHOR = "prd-12.2-claude-md-7";

/**
 * The SVA/digital-services/third-party section names PRD §20.1 seeds per
 * telecom issuer (see `issuers.ts`'s `SEED`), collected once here so RN-020
 * anchors on the same literal strings rather than a second, drifting copy.
 * `pattern.spec.sections` compares this against `section.name` verbatim —
 * unlike `match`, it is not run through `normalizeDescription` — so these
 * must stay byte-for-byte identical to `issuers.ts`.
 */
const SVA_ANCHOR_SECTIONS = [
  "Aplicativos Digitais",
  "Serviços Digitais",
  "Serviços Digitais avulsos",
  "Cobrança de Serviços de terceiros",
  "Adicionais Contratados",
  "Serviços de valor adicionado(SVA)",
  "Outros Pacotes e Serviços Mensais",
  "lançamentos diversos",
  "Outros Valores",
  "SERVICOS FACILIDADES",
  "OUTRAS COBRANCAS",
];

/**
 * CLAUDE.md §7.1 — every ✅ confirmed SVA anchor term and item name, plus
 * the Vivo "Serviços Digitais III" package (see the module doc comment,
 * finding #1). Bare alternation only (no repeated group wraps it), so
 * `assertSafePattern` accepts it outright — see `safe-regex.ts`.
 */
const RN_020_MATCH =
  "SVA|SKEELO|GO ?READ|HUBE JORNA(L|IS)|NBA BASICO|CLUBE DE REVISTAS|FUNKIDS|" +
  "UBOOK|TDATA|MCAFEE|VIVO MEDITACAO LITE|SERVICOS DIGITAIS III|" +
  "COBRANCA DE SERVICOS DE TERCEIRO";

/** CLAUDE.md §7.3 — every ✅ confirmed embedded-insurance term. */
const RN_021_MATCH = "CARTAO PROTEGIDO|FATURA PROTEGIDA|PRESTAMISTA|CHUBB";

/**
 * CLAUDE.md §7.2 — every ✅ confirmed payment-processor descriptor prefix.
 * See the module doc comment for why the short prefixes carry
 * word-boundary lookarounds and why Iugu/Vindi/Pagar.me/Asaas/pure
 * acquirers are absent on purpose.
 */
const RN_023_MATCH =
  "(?<![A-Z])MP(?![A-Z])|(?<![A-Z])PAG(?![A-Z])|(?<![A-Z])PP(?![A-Z])|EBANX|EBW|" +
  "(?<![A-Z])DL(?![A-Z])|DLOCAL|HTM|(?<![A-Z])HT(?![A-Z])|APPMAX|APPX";

type LexiconRule = {
  slug: string;
  category: Category;
  spec: RuleSpec;
  legalBasis: LegalRef[];
  confidenceBase: number;
  reason: string;
};

export const LEXICON_RULES: readonly LexiconRule[] = [
  {
    slug: RN_020,
    category: "telecom",
    spec: {
      kind: "pattern",
      sections: SVA_ANCHOR_SECTIONS,
      match: RN_020_MATCH,
    },
    legalBasis: [
      { law: "CDC", article: "39, III, parágrafo único", effect: "vedada" },
      {
        law: "RGC (Res. Anatel 632/2014, base doutrinária ainda citada; revogada pela Res. 765/2023)",
        article: "art. 64",
        effect: "vedada",
      },
      {
        law: "MP-GO",
        article: "processo 5223695.65.2019.8.09.0051",
        effect: "vedada",
        note: "Precedente citado no PRD §12.2 para SVA não contratado em fatura de telecom.",
      },
    ],
    confidenceBase: 0.88,
    reason:
      "RN-020 (PRD §12.2): item de SVA (léxico ✅ confirmado em CLAUDE.md §7.1) dentro de uma seção-âncora " +
      "de serviços digitais/adicionais/terceiros já seedada por emissor (PRD §20.1). Confiança 0,88 porque " +
      "esta linha só existe restrita à âncora confirmada — ver o comentário do módulo para a decisão de não " +
      "seedar também o tier 0,80 sem restrição de seção.",
  },
  {
    slug: RN_021,
    category: "card",
    spec: {
      kind: "pattern",
      match: RN_021_MATCH,
      requireRecurrence: 1,
    },
    legalBasis: [
      { law: "CDC", article: "39, I e III", effect: "vedada" },
      { law: "STJ", article: "Súmula 532", effect: "vedada" },
    ],
    confidenceBase: 0.72,
    reason:
      "RN-021 (PRD §12.2): linha de cartão casando com o léxico de seguro embutido (CLAUDE.md §7.3, ✅ " +
      "confirmado) e presente também na fatura anterior — proxy de 1 ciclo para o \"3+ ciclos\" do PRD, " +
      "já que o motor só carrega uma fatura anterior por vez (mesma limitação de RN-005 em deterministic.ts).",
  },
  {
    slug: RN_021_CONFIRM,
    category: "card",
    spec: {
      kind: "confirm",
      question: "Notamos uma cobrança recorrente no seu cartão que não bate com nenhum seguro já catalogado. Você reconhece e contratou essa cobrança?",
      options: ["Sim", "Não"],
      onNo: "create_finding",
    },
    legalBasis: [
      { law: "CDC", article: "39, I e III", effect: "vedada" },
      { law: "STJ", article: "Súmula 532", effect: "vedada" },
    ],
    confidenceBase: 0.4,
    reason:
      "RN-021 (PRD §12.2), metade \"vira confirm\": quando o padrão de recorrência bate mas o léxico de " +
      "seguro (CLAUDE.md §7.3) não casa, a cobrança vira pergunta, não achado direto — RF-124 trata " +
      "confiança abaixo de 0,55 assim. Ver o comentário do módulo para o que esta regra, do jeito que o " +
      "kind confirm existe hoje, ainda não consegue condicionar sozinha.",
  },
  {
    slug: RN_023,
    category: "card",
    spec: {
      kind: "pattern",
      match: RN_023_MATCH,
      requireRecurrence: 1,
    },
    legalBasis: [{
      law: "CDC",
      article: "6º, III",
      effect: "cancelamento",
      note:
        "RN-023 classifica a cobrança como assinatura recorrente para o app indicar onde cancelar; não é, " +
        "por si, achado de cobrança indevida (PRD §12.2). A base legal aqui é o direito à informação " +
        "adequada e clara sobre o serviço, não uma alegação de ilegalidade.",
    }],
    confidenceBase: 0.9,
    reason:
      "RN-023 (PRD §12.2): descritor casando prefixo de processador de pagamento ✅ confirmado " +
      "(CLAUDE.md §7.2) e presente também na fatura anterior — mesmo proxy de 1 ciclo de RN-021 para o " +
      "\"3+ ciclos\" do PRD. Classifica a cobrança como assinatura recorrente; não afirma cobrança indevida.",
  },
];

/**
 * Seeds the four rows above as `shadow`, versioned `rules` rows — same
 * idempotent upsert-by-(slug,version) as `seedDeterministicRules`, and the
 * same reason for leaving `status`/`shadowUntil` alone on conflict: RF-126/
 * 127 move a rule between shadow/active/paused from real firing data, and a
 * reseed must not silently undo that.
 */
export async function seedLexiconRules(db: Database): Promise<void> {
  const shadowUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  for (const entry of LEXICON_RULES) {
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
