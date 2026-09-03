import { and, eq, ne } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { TaskHandler } from "@pentefino/adapters";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";

const { agentProposals, events, ruleMetrics, rules } = schema;

export type RuleLifecycleDeps = {
  db: Database;
};

// RF-126: promote shadow → active at pelo menos 30 disparos.
const PROMOTE_MIN_FIRED = 30;
// RF-127: pause active → paused at 50+ disparos.
const PAUSE_MIN_FIRED = 50;

/**
 * The 0,15 cutoff, as an exact integer ratio (15/100 reduced to 3/20)
 * instead of the float literal `0.15`. RF-126/RF-127's comparisons below
 * are done by cross-multiplying two whole numbers (`dismissed * 20` vs.
 * `fired * 3`) rather than computing `dismissed / fired` and comparing that
 * to `0.15` — both `fired` and `dismissed` are exact integer counts, so the
 * cross-multiplied comparison is exact for every input, whereas a float
 * division risks a boundary case (a rule sitting at *precisely* 15%, which
 * the brief calls out by name) landing a floating-point hair to the wrong
 * side of `0.15` depending on the specific fired/dismissed pair. This is
 * the same "integers, not floats, at the boundary" discipline this codebase
 * already applies to money (cents, never fractional currency units).
 */
const RATIO_NUM = 3;
const RATIO_DEN = 20;

/** dismissed/fired < 0,15, computed without division. */
function belowRatio(dismissed: number, fired: number): boolean {
  return dismissed * RATIO_DEN < fired * RATIO_NUM;
}

/** dismissed/fired > 0,15, computed without division. */
function aboveRatio(dismissed: number, fired: number): boolean {
  return dismissed * RATIO_DEN > fired * RATIO_NUM;
}

type Rule = typeof rules.$inferSelect;

type Totals = { fired: number; dismissed: number };

async function totalsFor(db: Database, ruleSlug: string, ruleVersion: number): Promise<Totals> {
  const rows = await db
    .select({ fired: ruleMetrics.fired, dismissed: ruleMetrics.dismissed })
    .from(ruleMetrics)
    .where(and(eq(ruleMetrics.ruleSlug, ruleSlug), eq(ruleMetrics.ruleVersion, ruleVersion)));

  return rows.reduce<Totals>(
    (acc, row) => ({ fired: acc.fired + row.fired, dismissed: acc.dismissed + row.dismissed }),
    { fired: 0, dismissed: 0 },
  );
}

async function recordTransition(
  db: Database,
  rule: Rule,
  type: "rule_promoted" | "rule_paused",
  totals: Totals,
): Promise<void> {
  await db.insert(events).values({
    id: newId("evt"),
    type,
    payload: { ruleId: rule.id, ruleSlug: rule.slug, ruleVersion: rule.version, ...totals },
  });
}

/**
 * RF-301 opened a hole `ingest.ts`'s rule query does not close: it loads
 * every row whose status is `active` *or* `shadow` for a slug with no
 * "latest version only" filter, which is exactly right while v2 sits in
 * `shadow` (that is the whole point of shadow mode — v2's findings stay
 * invisible while v1 keeps serving real reports) and exactly wrong the
 * moment v2 becomes `active` too: both versions now match the same item
 * and each writes its own finding, double-counting one charge on a real
 * person's report. `applyRulePromotionProposal` is the only function that
 * can set a rule `active` (global constraint 7), so it is the only place
 * that can know, at the moment it creates a second `active` row for a
 * slug, that a first one now has to step aside — see this function's own
 * call to `retireSupersededVersions` below for where that happens and why
 * it happens *after* the promotion, not before or instead of it.
 *
 * Keyed on `slug`, not "every currently active rule": an unrelated slug's
 * `active` row is a different rule entirely and must never be touched by
 * promoting this one. Only a row that is *currently* `active` is retired —
 * a predecessor a human already paused, or one still sitting in `shadow`,
 * is left exactly as it is; this call does not resurrect or reinterpret
 * either state, it only closes the one specific hole promotion itself just
 * opened.
 */
async function retireSupersededVersions(db: Database, promoted: Rule, proposalId: string): Promise<void> {
  const predecessors = await db
    .select()
    .from(rules)
    .where(and(eq(rules.slug, promoted.slug), eq(rules.status, "active"), ne(rules.id, promoted.id)));

  for (const predecessor of predecessors) {
    await setStatus(db, predecessor.id, "paused");
    await db.insert(events).values({
      id: newId("evt"),
      type: "rule_version_superseded",
      payload: {
        ruleId: predecessor.id,
        ruleSlug: predecessor.slug,
        supersededVersion: predecessor.version,
        bySupersedingVersion: promoted.version,
        proposalId,
      },
    });
  }
}

/**
 * RF-301: a status transition is an UPDATE of the existing `(slug,
 * version)` row's `status` — not a new version, and not a touch of `spec`,
 * `legalBasis` or any other content column. Nothing here ever mutates the
 * evidence (`rules.spec`) a later pause would need to explain itself
 * against; only the lifecycle flag moves. Editing a rule's *content*
 * (RF-301's "creates a new version") is a separate, not-yet-built CRUD
 * concern this task does not touch — see `seedDeterministicRules`'s own
 * comment on why a reseed leaves `status`/`shadowUntil` alone for the exact
 * mirror-image reason.
 */
async function setStatus(db: Database, ruleId: string, status: "active" | "paused"): Promise<void> {
  await db.update(rules).set({ status }).where(eq(rules.id, ruleId));
}

/**
 * The RF-303 evidence a promotion decision rests on: the two raw counts and
 * the ratio derived from them, plus the window they were measured over.
 * Kept as human-readable strings, not a nested object, because
 * `agent_proposals.evidence` is typed `string[]` (§6.2) — the same shape
 * every other proposal kind uses. This is what stands between "a rule fired
 * 30 times" and a human being able to tell, at a glance, whether that is a
 * good record or a shadow rule's structural zero (see the doc comment on
 * `promoteShadowRules` below for why that distinction is the entire point
 * of this task).
 */
function promotionEvidence(rule: Rule, totals: Totals): string[] {
  return [
    `fired=${totals.fired}`,
    `dismissed=${totals.dismissed}`,
    `ratio=${totals.dismissed}/${totals.fired}`,
    `window=cumulative rule_metrics for (${rule.slug}, v${rule.version}), every day on record`,
  ];
}

/**
 * Guards `promoteShadowRules`' idempotency the same way `eq(rules.status,
 * "shadow")` guards it against re-promoting an already-active rule: a rule
 * that already has an undecided `promote_rule` proposal does not get a
 * second one on the next nightly run just because it is still sitting in
 * `shadow` waiting for a human (which, before block E11 ships, it always
 * will be — see `createRuleLifecycleTask`'s doc comment).
 */
async function hasPendingPromotionProposal(db: Database, ruleId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentProposals.id })
    .from(agentProposals)
    .where(
      and(
        eq(agentProposals.kind, "promote_rule"),
        eq(agentProposals.target, ruleId),
        eq(agentProposals.status, "pending"),
      ),
    );
  return rows.length > 0;
}

/**
 * Writes the RF-126 promotion decision as a `pending` `agent_proposals` row
 * instead of applying it — see `promoteShadowRules` for why. `target` is
 * the rule's own id, which is also what `hasPendingPromotionProposal` keys
 * its idempotency check on; `payload` repeats the rule's identity
 * (`ruleId`/`ruleSlug`/`ruleVersion`) so `applyRulePromotionProposal` can
 * find it back without depending on `target`'s string shape ever meaning
 * only one thing across every proposal `kind`.
 */
async function proposeRulePromotion(db: Database, rule: Rule, totals: Totals): Promise<void> {
  const proposalId = newId("prp");

  await db.insert(agentProposals).values({
    id: proposalId,
    kind: "promote_rule",
    target: rule.id,
    payload: { ruleId: rule.id, ruleSlug: rule.slug, ruleVersion: rule.version },
    evidence: promotionEvidence(rule, totals),
  });

  await db.insert(events).values({
    id: newId("evt"),
    type: "proposal_created",
    payload: {
      proposalId,
      kind: "promote_rule",
      ruleId: rule.id,
      ruleSlug: rule.slug,
      ruleVersion: rule.version,
      ...totals,
    },
  });
}

/**
 * RF-126: a `shadow` rule *qualifies* for promotion once its cumulative
 * `dismissed / fired` ratio is strictly below 0,15 *and* it has fired at
 * least 30 times. Below either bar — fewer than 30 firings, or a ratio at
 * or above 0,15 — it simply stays in `shadow`; nothing is written for a
 * rule that does not qualify, only for one that does.
 *
 * The boundary at exactly 0,15 is deliberately *not* promotion-eligible:
 * RF-126 says "below 0,15", not "at or below", so a rule sitting exactly on
 * the cutoff has not yet proven itself strictly better than the bar the PRD
 * set and stays in shadow for one more firing before it can graduate. See
 * `belowRatio`/`aboveRatio` above for why that exact tie goes the same way
 * (favouring more evidence) on both sides of the shadow/active boundary.
 *
 * Totals are cumulative across every `rule_metrics` day recorded for this
 * exact `(ruleSlug, ruleVersion)` — not just "today" — because RF-126's
 * "pelo menos 30 disparos" is a claim about the rule's whole shadow record,
 * not about any single day's traffic. A new version starts this count at
 * zero on its own (RF-301: a new version is a new row, a new
 * `(ruleSlug, ruleVersion)` key in `rule_metrics`), which is exactly what
 * keeps an edited rule from inheriting a prior version's track record.
 *
 * Qualifying no longer flips `rules.status` directly, and that change is
 * the entire point of this task. Shadow mode's own premise is that a
 * shadow rule's findings are never shown to anyone — no admin surface and
 * no user route exists for one, by design — so a user can *never* dismiss
 * one. That means `dismissed` is structurally 0 for the whole time a rule
 * sits in `shadow`, `belowRatio(0, fired)` is true for any `fired > 0`, and
 * the old code's "promote automatically once the ratio clears the bar"
 * degenerated into "promote automatically on the thirtieth firing,
 * regardless of quality" — the false-positive filter shadow mode exists to
 * be never actually filtered anything; it only delayed. RF-304 draws the
 * line this task now enforces: an ajuste de confiança in ±0,1 or a variant
 * promotion at n ≥ 100 per arm are automatic because they adjust something
 * already in front of users, but "regra nova" — a rule's findings reaching
 * a real user for the first time, which is exactly what shadow→active is —
 * explicitly "exige aprovação". So a qualifying rule now gets a `pending`
 * `agent_proposals` row (`kind: "promote_rule"`, see `proposeRulePromotion`)
 * carrying the RF-303 evidence a human needs to actually judge it, and
 * stays in `shadow` until `applyRulePromotionProposal` (below) is called
 * against that proposal. Nothing in this function can ever set a rule
 * `active` on its own.
 */
async function promoteShadowRules(db: Database): Promise<void> {
  const shadowRules = await db.select().from(rules).where(eq(rules.status, "shadow"));

  for (const rule of shadowRules) {
    const totals = await totalsFor(db, rule.slug, rule.version);
    if (totals.fired < PROMOTE_MIN_FIRED) continue;
    if (!belowRatio(totals.dismissed, totals.fired)) continue;
    if (await hasPendingPromotionProposal(db, rule.id)) continue;

    await proposeRulePromotion(db, rule, totals);
  }
}

/**
 * RF-127: an `active` rule pauses to `paused` when its cumulative
 * `dismissed / fired` ratio is strictly above 0,15 *and* it has fired at
 * least 50 times. Below either bar it keeps running.
 *
 * Symmetric boundary choice to `promoteShadowRules`: exactly 0,15 is *not*
 * pause-eligible either. RF-127 says "above 0,15", and §15.3's "Regra ruim"
 * alert names the same condition as "> 15%" — a rule sitting exactly at the
 * cutoff has not yet crossed the line the PRD drew, so it is left running
 * rather than shut off on a tie. Together the two thresholds leave a rule
 * already active at exactly 0,15 undisturbed (it is not promotion-eligible
 * either — promotion only ever applies to a `shadow` rule, and this one is
 * past that stage), which is the intended reading of the gap the brief
 * calls out: `< 0,15` and `> 0,15` are not meant to meet in the middle, they
 * are meant to leave a one-point-of-no-action band exactly where a rule
 * already earned its current state and a single ambiguous data point should
 * not flip it back and forth.
 *
 * RF-127 also says the pause "gera alerta" (§15.3: "Regra ruim … Pausa
 * automática + revisão"). This codebase has no separate alert table or
 * notification port (checked: none exists as of this task, and the
 * `ai_calls`-cost alert in `packages/adapters/src/ai/gateway.ts` is
 * likewise just a query over stored data, not a dedicated mechanism) — the
 * `rule_paused` event itself, carrying the exact fired/dismissed totals
 * that triggered it, *is* the alert: `events`' `byTypeTime` index
 * (`schema.ts`) exists precisely so a dashboard or on-call job can watch
 * `type = 'rule_paused'` without any additional plumbing.
 */
async function pauseActiveRules(db: Database): Promise<void> {
  const activeRules = await db.select().from(rules).where(eq(rules.status, "active"));

  for (const rule of activeRules) {
    const totals = await totalsFor(db, rule.slug, rule.version);
    if (totals.fired < PAUSE_MIN_FIRED) continue;
    if (!aboveRatio(totals.dismissed, totals.fired)) continue;

    await setStatus(db, rule.id, "paused");
    await recordTransition(db, rule, "rule_paused", totals);
  }
}

/**
 * RF-126/RF-127's nightly companion to `rule-metrics.ts`: reads the
 * `rule_metrics` that job materialised and moves rules between `shadow`,
 * `active` and `paused` — with one asymmetry between those two verbs.
 * Pausing still "moves" a rule: `pauseActiveRules` flips `rules.status`
 * directly, exactly as before, because RF-127 keeps that transition fully
 * automatic (it is the safe direction — it only ever shows *fewer*
 * findings). Promoting no longer moves anything by itself: it only writes a
 * `pending` proposal (see `promoteShadowRules`'s doc comment for why), so a
 * `shadow` rule stays exactly in `shadow` for as long as that proposal
 * remains undecided.
 *
 * No clock is injected here (unlike `expire-files.ts`/`rule-metrics.ts`)
 * because nothing in this task depends on "now" — every decision is a pure
 * aggregate over `rule_metrics` rows that already carry their own `day`.
 *
 * Idempotent by construction (A4): once a rule's `status` moves off
 * `active` the pause pass's `eq(rules.status, "active")` filter excludes
 * it from a later run, so pausing cannot double-fire. Promotion's
 * idempotency is the same shape one level removed —
 * `hasPendingPromotionProposal` excludes a `shadow` rule that already has
 * an undecided proposal, so a second run in a row cannot write a second
 * proposal for it — see the "idempotency" tests in
 * `rule-lifecycle.test.ts`.
 *
 * The consequence worth stating plainly, not burying: as of this task there
 * is no surface anywhere in this codebase for a human to *see* a pending
 * `promote_rule` proposal, let alone decide it. RF-300's admin panel
 * (block E11) is what will eventually list `agent_proposals` and call
 * `applyRulePromotionProposal` (below) from an "Aprovar" button. Until E11
 * ships, a proposal that reaches `pending` here sits there — reachable only
 * by reading `agent_proposals` directly (SQL, a script, a REPL) and calling
 * `applyRulePromotionProposal` by hand. That is deliberate, not a stall
 * this task failed to close: RF-304's own acceptance criterion is that an
 * out-of-band proposal "fica `pending`", and §18's quality bar
 * ("leitura manual de cada descarte") already expects a person, not a job,
 * to be the one who looks. Building that surface is E11's job, not E2's.
 */
export function createRuleLifecycleTask(deps: RuleLifecycleDeps): TaskHandler {
  const { db } = deps;

  return async function runRuleLifecycle(): Promise<void> {
    await promoteShadowRules(db);
    await pauseActiveRules(db);
  };
}

export type ApplyRulePromotionProposalInput = {
  proposalId: string;
  decidedBy: string;
  decisionReason: string;
};

/**
 * The only path in this codebase that can set a `shadow` rule's `status` to
 * `active`. `promoteShadowRules` never calls this — it only writes the
 * `pending` proposal this function later acts on (see its doc comment, and
 * `createRuleLifecycleTask`'s, for the full argument). Until block E11
 * builds an admin surface over `agent_proposals`, calling this function
 * directly *is* the RF-304 approval action ("regra nova ... exige
 * aprovação"): a human reviews the proposal's `evidence` by whatever means
 * exists today, and this call both records that decision and applies its
 * effect in the same step an admin panel's "Aprovar" button will later
 * trigger by calling this same function.
 *
 * Refuses (throws) rather than silently no-op-ing when:
 *  - no `agent_proposals` row has this id;
 *  - the row's `kind` is not `promote_rule` (this function only knows how
 *    to apply this one kind — approving `pause_rule` or `adjust_confidence`
 *    proposals, once those exist, needs their own apply path with their own
 *    effect, not this one reused past what it actually does);
 *  - the row is not currently `pending` (a decided proposal is not
 *    re-decidable through this path — re-running it would let a second,
 *    possibly-conflicting `decidedBy`/`decisionReason` overwrite the
 *    decision that was actually acted on);
 *  - the target rule is no longer `shadow` (RF-301's CRUD lets a rule be
 *    edited directly since the proposal was written; applying a stale
 *    proposal against a rule state it was never evaluated against is
 *    exactly the kind of ungated promotion this task exists to close).
 *
 * Totals for the `rule_promoted` event are re-read from `rule_metrics` at
 * apply time rather than trusted from the proposal's `evidence` strings.
 * A proposal can sit `pending` for days before a human reaches it (there is
 * no surface prompting them to, per `createRuleLifecycleTask`'s doc
 * comment), and the event recording the moment a rule actually went live
 * should describe the totals true at that moment, not a snapshot from
 * whenever the proposal happened to be written.
 *
 * After the promotion, this is also the one place that can retire a
 * superseded predecessor (`retireSupersededVersions`, above) — RF-301
 * versioning lets a slug carry v1 `active` and v2 `shadow` at once, which
 * is correct while v2 stays invisible, but the instant this function makes
 * v2 `active` too, `ingest.ts`'s no-latest-version-filter query starts
 * matching both rows against the same item and double-counts a real
 * charge. This function is the only one that can see that moment happen,
 * because it is the only one allowed to cause it (global constraint 7).
 *
 * Deliberately promote-then-retire, not the other way round or a single
 * transaction: if the process crashes between the two writes, the visible
 * failure is two `active` versions both firing — duplicate findings a
 * human can spot and fix by pausing one manually. Retiring first (or
 * failing partway through a combined step that leaves the predecessor
 * paused before the successor is confirmed active) risks the opposite
 * failure — a window, or a crash, that leaves a slug with *no* `active`
 * version — which is a detection silently gone with nothing in the UI to
 * say so. Loud-and-duplicated beats quiet-and-missing, so promotion is
 * unconditionally first.
 */
export async function applyRulePromotionProposal(
  deps: RuleLifecycleDeps,
  input: ApplyRulePromotionProposalInput,
): Promise<void> {
  const { db } = deps;
  const { proposalId, decidedBy, decisionReason } = input;

  const [proposal] = await db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
  if (!proposal) {
    throw new Error(`rule-lifecycle: no agent_proposals row with id ${proposalId}`);
  }
  if (proposal.kind !== "promote_rule") {
    throw new Error(
      `rule-lifecycle: agent_proposals ${proposalId} is a "${proposal.kind}" proposal, not "promote_rule"`,
    );
  }
  if (proposal.status !== "pending") {
    throw new Error(`rule-lifecycle: agent_proposals ${proposalId} is already "${proposal.status}", not pending`);
  }

  const payload = proposal.payload as { ruleId?: unknown };
  const ruleId = typeof payload.ruleId === "string" ? payload.ruleId : undefined;
  if (!ruleId) {
    throw new Error(`rule-lifecycle: agent_proposals ${proposalId} payload has no ruleId`);
  }

  const [rule] = await db.select().from(rules).where(eq(rules.id, ruleId));
  if (!rule) {
    throw new Error(`rule-lifecycle: rule ${ruleId} referenced by proposal ${proposalId} no longer exists`);
  }
  if (rule.status !== "shadow") {
    throw new Error(
      `rule-lifecycle: rule ${ruleId} is "${rule.status}", not "shadow" — refusing to apply stale proposal ${proposalId}`,
    );
  }

  const totals = await totalsFor(db, rule.slug, rule.version);

  await setStatus(db, rule.id, "active");
  await recordTransition(db, rule, "rule_promoted", totals);

  // Promote first, retire second — see this function's doc comment for why
  // that order, not the reverse, is what keeps a crash mid-way visible
  // (duplicate findings) instead of silent (a detection gone).
  await retireSupersededVersions(db, rule, proposalId);

  await db
    .update(agentProposals)
    .set({ status: "approved", decidedBy, decisionReason })
    .where(eq(agentProposals.id, proposalId));

  await db.insert(events).values({
    id: newId("evt"),
    type: "proposal_decided",
    payload: {
      proposalId,
      kind: "promote_rule",
      ruleId: rule.id,
      ruleSlug: rule.slug,
      ruleVersion: rule.version,
      decidedBy,
      decisionReason,
      status: "approved",
    },
  });
}
