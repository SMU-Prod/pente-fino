import {
  applySuppressors, arithmetic, confirm, delta, pattern, reference, threshold,
  type EvaluationContext, type Evaluator,
} from "./evaluators/index.js";
import { formatCentsBRL } from "./evaluators/shared.js";
import type { InvoiceCanonical } from "../invoice/canonical.js";
import type { Finding } from "./finding.js";
import type { ReferenceFlag, ReferenceTariff } from "./references.js";
import type { LegalRef, RuleSpec } from "./spec.js";

export type ActiveRule = {
  slug: string;
  version: number;
  spec: RuleSpec;
  confidenceBase: number;
  shadow: boolean;
  // RF-129/RF-161: every finding this rule produces must carry at least one
  // of these — the model never supplies legalBasis, only the fired rule does.
  legalBasis: LegalRef[];
  // RF-123: null means the generic rule for `slug`. A non-null issuerId
  // outranks the generic rule of the same slug, resolved inside the engine
  // rather than depending on how the caller happened to query `rules`.
  issuerId: string | null;
};

export type RuleEngineInput = {
  invoice: InvoiceCanonical;
  previous: InvoiceCanonical | null;
  rules: ActiveRule[];
  answers: Record<string, string>;
  // RN-040/RN-041: ANEEL tariff and flag tables. External data the engine
  // cannot derive from the invoices itself, so it arrives as an argument —
  // RF-120 requires the engine to stay free of I/O.
  references: {
    tariffs: ReferenceTariff[];
    flags: ReferenceFlag[];
  };
};

/**
 * Evaluates every active rule over an invoice and returns the findings a
 * user is shown (RF-120: pure, deterministic, no I/O — nothing here reads a
 * clock, a database, or `Math.random`, and nothing mutates `input`).
 *
 * ## Order of operations (load-bearing — read this before changing the order)
 *
 * Each step consumes the previous step's output. Reordering any two of
 * these silently changes what a user sees, not just how the code is
 * organised:
 *
 *   1. **Select** — resolve `input.rules` down to the rules that actually
 *      apply (see "Selection is mostly RF-123" below).
 *   2. **RF-123 precedence** — of the rules selected in step 1, an
 *      issuer-specific rule (`issuerId !== null`) outranks the generic rule
 *      (`issuerId === null`) of the same `slug`; only the specific one's
 *      finding is created, never both and never the generic one filtered
 *      out afterwards. In this engine, steps 1 and 2 are the same pass —
 *      see below for why "select" has nothing left to do once precedence
 *      is resolved.
 *   3. **Evaluate, then suppress** — every selected rule (other than
 *      `suppressor`-kind ones) runs through its matching evaluator; the
 *      raw findings then pass through the suppressor phase (§12.4), which
 *      removes whatever it names.
 *   4. **RF-124 thresholds** — a finding below confidence 0.55 is demoted
 *      to a question (`askUser` attached) rather than returned as a
 *      visible accusation.
 *   5. **RF-128 clustering (RN-022)** — among the findings still visible
 *      after step 4 (a question is not yet a confirmed achado, so it is
 *      never a clustering candidate), three or more sharing a section
 *      produce one aggregate finding, prepended so it is shown first. The
 *      individual findings are NOT removed — the PRD's own example shows
 *      the aggregate "antes das linhas individuais" (before them), not
 *      instead of them.
 *   6. **RF-129 enforcement** — any finding, aggregate or not, lacking
 *      `evidence` or `legalBasis` is dropped. This runs LAST, after
 *      clustering, exactly as specified — see "RF-129 runs after
 *      clustering, on purpose" below for what that implies.
 *
 * ## Selection is mostly RF-123 (steps 1 and 2 are one pass)
 *
 * `ActiveRule` carries no `category` field, and `InvoiceCanonical` carries
 * no reference to a specific issuer row — only `issuer.category` and an
 * optional `issuer.cnpj`. There is therefore no axis left inside this
 * engine along which to filter `input.rules` further: RF-120's "avalia
 * todas as regras ativas da categoria (e as do emissor)" describes the
 * caller's query (`WHERE status = 'active' AND (category = ? OR issuerId =
 * ?)`), not a second filter the engine could apply from the data it has.
 * What the engine CAN and must do with the candidates it receives is
 * collapse duplicate `slug`s down to one rule per slug, per RF-123: an
 * issuer-specific entry wins over a generic one of the same slug. Two
 * different non-null `issuerId`s sharing one slug would mean the caller
 * mixed candidates for more than one issuer into a single call — outside
 * this engine's ability to arbitrate, and assumed not to happen.
 *
 * ## Task 3's suppressor evaluator
 *
 * RF-121 names `suppressor` as a seventh evaluator kind, built in Task 3 of
 * this same block, running in parallel with this one. Task 3 had not landed
 * when this file was started: `evaluators/index.ts` exported only the six
 * evaluators that produce findings, with no `evaluators/suppressor.ts` to
 * import. `applySuppressorPhase` began as this engine's own implementation
 * of that phase against the exact `RuleSpec` "suppressor" shape already
 * defined in `spec.ts` (`blocks`/`reason`) — a real implementation, not a
 * stub, so the pipeline was correct even before Task 3 shipped. Task 3
 * landed and merged into this same branch while this file was still being
 * written, at which point `applySuppressorPhase` was rewritten to its
 * current body: a thin wrapper around `applySuppressors` from
 * `evaluators/suppressor.ts` (re-exported through `evaluators/index.ts`),
 * which matches `spec.blocks` (regex sources) against each finding's own
 * `evidence` text rather than against `ruleSlug` — see that module's doc
 * comment for why (INV-010 must catch a dead thesis even under a rule slug
 * that names nothing about it). This engine trusts that design outright
 * rather than re-implementing or second-guessing it.
 *
 * One gap this integration leaves open, worth flagging rather than hiding:
 * `applySuppressors` returns `{ survivors, suppressed }`, and its own doc
 * comment expects the caller to "record `result.suppressed` somewhere an
 * operator can later ask 'why didn't this fire'" — an audit trail, not a
 * silent drop. `runRules`'s signature returns only `Finding[]` (kept as
 * specified for this task), so `applySuppressorPhase` below keeps only
 * `.survivors` and discards `.suppressed` entirely. Nothing downstream of
 * `runRules` can answer "why didn't this fire" today. Surfacing that
 * without changing this function's signature — a second return channel, a
 * side-effecting logger port, or similar — is a real, undecided design
 * question for whichever task wires this engine into the ingest pipeline.
 *
 * ## RF-124's two boundaries do not carry equal weight here
 *
 * PRD §10 phrases the low cut as "confiança **< 0,55**" and the high cut as
 * "**acima de** 0,8" — both strict/exclusive in the PRD's own words, so
 * 0.55 itself and 0.8 itself both land in the middle "verificar" band, not
 * the neighbouring one. Only the low cut changes what this function
 * returns: below it, `askUser` is attached and the finding is a question
 * rather than a visible accusation. The high cut changes nothing about a
 * `Finding`'s shape — "verificar" (0,55–0,8) and "provável cobrança a
 * contestar" (>0,8) are two labels for the same kind of visible finding,
 * distinguished only by reading `confidence` directly, which is exactly
 * what `Finding` already exposes. That labelling is E3's job (the
 * laudo/card UI, §13.2), not something to encode as a second branch here
 * with no observable effect on this function's return value.
 *
 * ## Clustering key: the rule's own single declared section, not the item's
 *
 * `Finding` carries no section field — `itemId` is always `null` today (see
 * `pattern.ts`'s own doc comment: no persisted item id exists yet at this
 * layer), so a finding cannot be traced back to "which section" after the
 * fact. Rather than inventing a new field on `Finding` (which every one of
 * the six evaluator modules would then have to populate, well outside this
 * task's scope), this engine uses the firing rule's own declared
 * `spec.sections` when it names **exactly one** section: a `pattern` rule
 * scoped to one section necessarily produces every one of its findings from
 * items inside that section (see `pattern.ts`'s scan loop), so the section
 * name is real data the rule already carries, not a guess. A rule with no
 * `sections` restriction (matches anywhere) or more than one declared
 * section is ambiguous and is simply never a clustering candidate; nor is
 * any non-`pattern` finding, since no other `RuleSpec` kind has a
 * comparable "which section" concept at all. "Same cycle" (RN-022's other
 * half) needs no separate check: one `runRules` call always evaluates
 * exactly one invoice, so every finding it produces already shares one
 * cycle by construction.
 *
 * The aggregate's `ruleSlug` is synthetic (`` `cluster:${section}` ``) —
 * deliberately never a real `rules.slug`, so it cannot be confused with one
 * of the rules that fed it. It therefore also cannot resolve to a row in
 * the `rules` table the way `findings.ruleId` expects (see
 * `packages/db/src/schema.ts`); whichever later task persists `Finding[]`
 * must special-case a `cluster:`-prefixed slug (skip the `rules` FK lookup,
 * or add a dedicated column) rather than treating it as an ordinary rule
 * hit. This is a known, deliberate boundary for that task to close, not an
 * oversight here.
 *
 * The aggregate's `confidence` is the minimum across its members (never
 * overstate the group's certainty beyond its weakest member) — and because
 * clustering only ever draws from findings that already survived step 4
 * (every candidate is, by construction, at or above 0.55), the aggregate
 * itself can never need to be demoted to a question; it is simply never
 * run back through step 4. `doubledCents` sums only the members that have
 * one (a member's own `legalBasis` decided that, via `computeDoubledCents`
 * in `evaluators/shared.ts`); with no member carrying a "dobro" citation,
 * the aggregate's `doubledCents` is `null`, matching how a single finding
 * represents "no doubling applies" rather than a doubled amount of zero.
 *
 * ## RF-129 runs after clustering, on purpose
 *
 * Because enforcement is the last step, a finding that fails it (missing
 * `evidence` or `legalBasis`) can still have already contributed its
 * amount to an aggregate built one step earlier, even though its own,
 * individual `Finding` is then dropped from the result. This looks like a
 * discrepancy but is exactly what the specified order produces, and is
 * covered by a dedicated test (`engine.test.ts`, RF-129 describe block) so
 * that swapping steps 5 and 6 — which would instead give a smaller,
 * "corrected" aggregate — fails loudly rather than silently changing the
 * total a user sees.
 */
export function runRules(input: RuleEngineInput): Finding[] {
  const selected = selectApplicableRules(input.rules);
  const ctx: EvaluationContext = {
    invoice: input.invoice,
    previous: input.previous,
    references: input.references,
    answers: input.answers,
  };

  const evaluated = runEvaluators(selected, ctx);
  const suppressed = applySuppressorPhase(selected, evaluated);
  const thresholded = applyConfidenceThresholds(suppressed);
  const clustered = applyClustering(thresholded, selected);
  return enforceEvidenceAndLegalBasis(clustered);
}

// ---------------------------------------------------------------------------
// Step 1/2 — selection is RF-123 precedence
// ---------------------------------------------------------------------------

function selectApplicableRules(rules: ActiveRule[]): ActiveRule[] {
  const bySlug = new Map<string, ActiveRule[]>();
  for (const rule of rules) {
    const bucket = bySlug.get(rule.slug);
    if (bucket) bucket.push(rule);
    else bySlug.set(rule.slug, [rule]);
  }

  const selected: ActiveRule[] = [];
  for (const group of bySlug.values()) {
    const specific = group.filter((rule) => rule.issuerId !== null);
    // `specific.length > 0` implies `specific` is the whole story for this
    // slug (the generic entries, if any, are outranked); otherwise `group`
    // contains only generic entries in the first place.
    selected.push(...(specific.length > 0 ? specific : group));
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Step 3a — run every evaluator
// ---------------------------------------------------------------------------

const EVALUATORS_BY_KIND: Record<Exclude<RuleSpec["kind"], "suppressor">, Evaluator> = {
  pattern, delta, threshold, reference, confirm, arithmetic,
};

function runEvaluators(rules: ActiveRule[], ctx: EvaluationContext): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    const kind = rule.spec.kind;
    // `suppressor`-kind rules do not produce findings of their own; they
    // are consulted only in `applySuppressorPhase` below. Routing one to
    // any of the six other evaluators would make it throw (they each
    // reject a rule whose `spec.kind` is not their own).
    if (kind === "suppressor") continue;
    findings.push(...EVALUATORS_BY_KIND[kind](rule, ctx));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Step 3b — suppressor phase (§12.4) — see the module doc comment ("Task 3's
// suppressor evaluator") for the history and for the audit-trail gap this
// leaves open.
// ---------------------------------------------------------------------------

function applySuppressorPhase(rules: ActiveRule[], findings: Finding[]): Finding[] {
  const suppressorRules = rules.filter((rule) => rule.spec.kind === "suppressor");
  if (suppressorRules.length === 0) return findings; // nothing to run `applySuppressors` over
  return applySuppressors(suppressorRules, findings).survivors;
}

// ---------------------------------------------------------------------------
// Step 4 — RF-124 thresholds
// ---------------------------------------------------------------------------

// Strict/exclusive, matching PRD §10's own "confiança < 0,55" — see the
// module doc comment's "RF-124's two boundaries" section for why only this
// one has an effect on what `runRules` returns.
const QUESTION_BELOW_CONFIDENCE = 0.55;

// §14.2's own suggested confirm phrasing (see `evaluators/confirm.ts`'s doc
// comment), reused verbatim rather than invented here: a "Não" answer must
// mean the user disputes the charge, exactly as every hand-authored
// `confirm` rule is already required to phrase it.
const GENERIC_CONFIRM_QUESTION = "Esta cobrança está correta?";
const GENERIC_CONFIRM_OPTIONS = ["Sim", "Não"] as const;

function applyConfidenceThresholds(findings: Finding[]): Finding[] {
  return findings.map((finding) => {
    if (finding.askUser !== undefined) return finding; // already a question
    if (finding.confidence >= QUESTION_BELOW_CONFIDENCE) return finding; // visible: "verificar" or "provável"
    return {
      ...finding,
      askUser: { question: GENERIC_CONFIRM_QUESTION, options: [...GENERIC_CONFIRM_OPTIONS] },
    };
  });
}

// ---------------------------------------------------------------------------
// Step 5 — RF-128 / RN-022 clustering
// ---------------------------------------------------------------------------

const CLUSTER_MIN_SIZE = 3;

type ClusterGroup = { section: string; shadow: boolean; members: Finding[] };

/**
 * The section a finding clusters under, or `null` if it is not a
 * clustering candidate at all. See the module doc comment ("Clustering
 * key") for why this is derived from the firing rule's own declared
 * `spec.sections` rather than from the `Finding` itself.
 */
function clusterSectionFor(finding: Finding, ruleBySlug: Map<string, ActiveRule>): string | null {
  if (finding.askUser !== undefined) return null; // a pending question, not yet a confirmed achado
  const rule = ruleBySlug.get(`${finding.ruleSlug}@${finding.ruleVersion}`);
  if (rule === undefined || rule.spec.kind !== "pattern") return null;
  const sections = rule.spec.sections;
  if (sections === undefined || sections.length !== 1) return null; // no single, unambiguous section
  return sections[0]!;
}

function applyClustering(findings: Finding[], rules: ActiveRule[]): Finding[] {
  const ruleBySlug = new Map(rules.map((rule) => [`${rule.slug}@${rule.version}`, rule] as const));
  const groups = new Map<string, ClusterGroup>();

  for (const finding of findings) {
    const section = clusterSectionFor(finding, ruleBySlug);
    if (section === null) continue;
    // Shadow and non-shadow findings never share a cluster (RF-125): an
    // aggregate built partly from unvetted shadow findings would itself
    // need to stay hidden, which a single visible/shadow aggregate cannot
    // represent, so the two populations are kept in separate groups.
    const key = `${section} ${String(finding.shadow)}`;
    const group = groups.get(key);
    if (group) group.members.push(finding);
    else groups.set(key, { section, shadow: finding.shadow, members: [finding] });
  }

  const aggregates: Finding[] = [];
  for (const group of groups.values()) {
    if (group.members.length < CLUSTER_MIN_SIZE) continue;
    aggregates.push(buildAggregateFinding(group));
  }

  return aggregates.length === 0 ? findings : [...aggregates, ...findings];
}

function buildAggregateFinding(group: ClusterGroup): Finding {
  const totalCents = group.members.reduce((sum, member) => sum + member.amountCents, 0);
  const doubledMembers = group.members.filter(
    (member): member is Finding & { doubledCents: number } => member.doubledCents !== null,
  );
  const doubledCents = doubledMembers.length === 0
    ? null
    : doubledMembers.reduce((sum, member) => sum + member.doubledCents, 0);
  const confidence = Math.min(...group.members.map((member) => member.confidence));
  const legalBasis = dedupeLegalBasis(group.members.flatMap((member) => member.legalBasis));

  return {
    // Synthetic, never a real `rules.slug` — see the module doc comment's
    // "Clustering key" section for why, and the follow-up it names for
    // whoever persists this.
    ruleSlug: `cluster:${group.section}`,
    ruleVersion: 1,
    itemId: null,
    amountCents: totalCents,
    doubledCents,
    confidence,
    evidence: [
      `${formatCentsBRL(totalCents)} em ${group.members.length} ${group.section.toLowerCase()} ` +
        "— para você verificar.",
    ],
    legalBasis,
    shadow: group.shadow,
  };
}

function dedupeLegalBasis(refs: LegalRef[]): LegalRef[] {
  const seen = new Set<string>();
  const deduped: LegalRef[] = [];
  for (const ref of refs) {
    const key = `${ref.law} ${ref.article} ${ref.effect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Step 6 — RF-129 enforcement
// ---------------------------------------------------------------------------

/**
 * Drops any finding missing `evidence` or `legalBasis` (RF-129). Rejects,
 * never repairs: there is no default evidence sentence or citation this
 * engine is entitled to invent on a rule's behalf. In practice every
 * evaluator this codebase ships always populates both from the firing
 * rule's own data, so this is a defensive backstop against a malformed
 * `ActiveRule` (e.g. `legalBasis: []`) rather than a path real rules take —
 * see `engine.test.ts` for a fixture that deliberately misconfigures a rule
 * to exercise it.
 */
function enforceEvidenceAndLegalBasis(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.evidence.length > 0 && finding.legalBasis.length > 0);
}
