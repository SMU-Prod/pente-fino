import { and, eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { TaskHandler } from "@pentefino/adapters";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";

const { events, ruleMetrics, rules } = schema;

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
 * RF-126: a `shadow` rule promotes to `active` only when its cumulative
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
 */
async function promoteShadowRules(db: Database): Promise<void> {
  const shadowRules = await db.select().from(rules).where(eq(rules.status, "shadow"));

  for (const rule of shadowRules) {
    const totals = await totalsFor(db, rule.slug, rule.version);
    if (totals.fired < PROMOTE_MIN_FIRED) continue;
    if (!belowRatio(totals.dismissed, totals.fired)) continue;

    await setStatus(db, rule.id, "active");
    await recordTransition(db, rule, "rule_promoted", totals);
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
 * `active` and `paused` accordingly. No clock is injected here (unlike
 * `expire-files.ts`/`rule-metrics.ts`) because nothing in this task depends
 * on "now" — every decision is a pure aggregate over `rule_metrics` rows
 * that already carry their own `day`.
 *
 * Idempotent by construction (A4): once a rule's `status` moves off
 * `shadow` (or off `active`), the `eq(rules.status, ...)` filters above
 * exclude it from the corresponding pass on every later run, so a second
 * run in a row cannot promote or pause the same rule twice or double-record
 * its transition event — see the "idempotency" test in
 * `rule-lifecycle.test.ts`.
 */
export function createRuleLifecycleTask(deps: RuleLifecycleDeps): TaskHandler {
  const { db } = deps;

  return async function runRuleLifecycle(): Promise<void> {
    await promoteShadowRules(db);
    await pauseActiveRules(db);
  };
}
