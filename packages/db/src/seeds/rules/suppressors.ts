import { sql } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { Category, RuleSpec } from "@pentefino/core";
import { rules } from "../../schema.js";
import type { Database } from "../../client.js";

/**
 * The three suppressors of PRD §12.4 (`INV-010`), seeded as `rules` rows of
 * `kind: "suppressor"`.
 *
 * ## Why `active`, not `shadow` — the one deliberate exception
 *
 * RF-125 says a new rule is born `draft` and only enters `shadow` on
 * activation; `deterministic.ts`'s eleven RN-001..011 rules follow that and
 * ship `shadow` because none of them has ever run against a real invoice.
 * A suppressor is the opposite case: it has no observation period to earn,
 * because sitting in `shadow` (or `draft`) suppresses nothing at all - the
 * engine only runs suppressors that are `active` (Task 4's step 3, "run
 * every evaluator, then the suppressors"). Shipping RN-090..092 as anything
 * other than `active` would leave the three dead theses fully signalable
 * for the entire time they sit un-promoted, which is exactly what
 * `INV-010` exists to forbid. The false-positive risk RF-125's shadow
 * period guards against does not apply symmetrically here either: a
 * suppressor firing "too often" only ever means one more finding a user
 * never sees, never a wrong accusation shown to them - the failure mode
 * shadow mode is built to catch before it reaches anyone.
 *
 * ## `legalBasis` is deliberately left empty
 *
 * `LegalRef.effect` (`"dobro" | "suspensao" | "cancelamento" |
 * "amostra_gratis" | "vedada" | "limite"`) has no value meaning "this
 * thesis is settled *against* the consumer" - every existing effect
 * describes a consequence in the consumer's favour. Forcing one of them
 * onto a suppressor (e.g. `"vedada"`, which would misread as "charging
 * this is forbidden" - the exact opposite of what RN-090..092 mean) would
 * be actively misleading, not just imprecise. The real citations (STJ
 * Tema 986, Tema 414, and the COSIP precedent) live in `reason` and
 * `spec.reason` instead, as free text - the same place `deterministic.ts`
 * puts its own PRD citations for every rule kind.
 *
 * ## `confidenceBase` is inert here
 *
 * `suppressor` (`packages/core/src/rules/evaluators/suppressor.ts`) never
 * reads `rule.confidenceBase` - it only removes findings other rules
 * already produced, at whatever confidence those rules gave them. The
 * column is `NOT NULL` regardless of kind, so it is set to `1` here as a
 * documented placeholder, not a meaningful value.
 *
 * ## `spec.blocks` — matching a thesis's content, never a rule's slug
 *
 * See `suppressor.ts`'s own doc comment for the full reasoning. In short:
 * `INV-010` must catch a rule that flags the same dead thesis under a slug
 * that names nothing about it, so matching cannot key on `ruleSlug`. Every
 * pattern below is tested against
 * `normalizeDescription(finding.evidence.join(" "))` - upper-cased,
 * accent-stripped, numbers dropped (RF-122) - so casing, accents and word
 * order do not matter. An "AND, either order" requirement is written with
 * lookaheads (`(?=.*X)(?=.*Y)`).
 */

export const RN_090 = "rn-090-icms-tusd-tust";
export const RN_091 = "rn-091-cosip-sem-poste";
export const RN_092 = "rn-092-agua-tarifa-minima-economia";

const AUTHOR = "prd-12.4";

type SuppressorRule = {
  slug: string;
  category: Category;
  spec: RuleSpec & { kind: "suppressor" };
  confidenceBase: number;
  reason: string;
};

export const SUPPRESSOR_RULES: readonly SuppressorRule[] = [
  {
    slug: RN_090,
    category: "energy",
    spec: {
      kind: "suppressor",
      // "ICMS" together with "TUSD" or "TUST", in either order - covers a
      // description like "ICMS sobre TUSD/TUST" as well as one that leads
      // with the tariff name ("TUSD com ICMS incluso").
      blocks: ["(?=.*\\bICMS\\b)(?=.*\\bTUSD\\b)", "(?=.*\\bICMS\\b)(?=.*\\bTUST\\b)"],
      reason:
        "O STJ decidiu no Tema 986 (13/03/2024) que o ICMS incide sobre TUSD/TUST - essa cobrança integra a " +
        "base de cálculo. A modulação de efeitos protege apenas quem tinha liminar sem depósito judicial " +
        "obtida até 27/03/2017.",
    },
    confidenceBase: 1,
    reason:
      "RN-090 (PRD §12.4): tese de exclusão do ICMS sobre TUSD/TUST está morta desde o Tema 986/STJ " +
      "(13/03/2024); sinalizar essa cobrança orientaria o usuário a contestar algo que vai perder.",
  },
  {
    slug: RN_091,
    category: "energy",
    spec: {
      kind: "suppressor",
      // "COSIP" together with either framing of "no lamppost" the PRD
      // names: absence of a pole, or absence of public lighting outright.
      blocks: ["(?=.*\\bCOSIP\\b)(?=.*\\bPOSTE\\b)", "(?=.*\\bCOSIP\\b)(?=.*\\bILUMINACAO\\b)"],
      reason:
        "Há precedente de que a COSIP é devida mesmo sem poste ou iluminação no logradouro do consumidor. " +
        "A tese válida contra a COSIP é ausência de lei municipal instituidora ou isenção legal expressa - " +
        "nunca a ausência física de poste.",
    },
    confidenceBase: 1,
    reason:
      "RN-091 (PRD §12.4): 'sem poste' não é motivo válido para contestar COSIP; sinalizar essa alegação " +
      "orientaria o usuário a uma tese perdedora.",
  },
  {
    slug: RN_092,
    category: "water",
    spec: {
      kind: "suppressor",
      // "tarifa mínima" + "economia" (the lawful fixed parcel per economia
      // itself), and separately "condomínio" + "economia" (a condominium
      // billed, or arguing to be billed, as one single economia) - both
      // phrasings the dead thesis can show up as.
      blocks: [
        "(?=.*\\bTARIFA\\b)(?=.*\\bMINIMA\\b)(?=.*\\bECONOMIA\\b)",
        "(?=.*\\bCONDOMINIO\\b)(?=.*\\bECONOMIA\\b)",
      ],
      reason:
        "O STJ reviu o Tema 414 em 27/06/2024: a parcela fixa mínima por economia é lícita. Continua " +
        "ilegal apenas tratar o condomínio inteiro como uma única economia e aplicar a faixa ao volume " +
        "total sem dividir pelas economias.",
    },
    confidenceBase: 1,
    reason:
      "RN-092 (PRD §12.4): tarifa mínima de água por economia está lícita desde a revisão do Tema 414/STJ " +
      "(27/06/2024); sinalizar essa cobrança orientaria o usuário a contestar algo que vai perder.",
  },
];

/**
 * Seeds the three suppressors above as `active`, versioned `rules` rows.
 *
 * On conflict (redeploy re-running the seed), only content is refreshed -
 * `spec`, `legalBasis` (always `[]`), `confidenceBase`, `category`,
 * `reason`. `status` is deliberately left untouched, same as
 * `seedDeterministicRules`: if an operator ever pauses a suppressor by
 * hand, a routine redeploy must not silently un-pause or re-activate it
 * out from under that decision. `shadowUntil` is not set on insert and
 * never touched on conflict - these rules never pass through `shadow`.
 */
export async function seedSuppressorRules(db: Database): Promise<void> {
  for (const entry of SUPPRESSOR_RULES) {
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
        legalBasis: [],
        confidenceBase: entry.confidenceBase,
        status: "active",
        shadowUntil: null,
        author: AUTHOR,
        reason: entry.reason,
      })
      .onConflictDoUpdate({
        target: [rules.slug, rules.version],
        set: {
          category: entry.category,
          kind: entry.spec.kind,
          spec: entry.spec,
          legalBasis: [],
          confidenceBase: entry.confidenceBase,
          reason: entry.reason,
          updatedAt: sql`now()`,
        },
      });
  }
}
