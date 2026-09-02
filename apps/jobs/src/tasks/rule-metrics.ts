import { and, gte, inArray, lt, sql } from "drizzle-orm";
import { newId, type EventType } from "@pentefino/core";
import type { TaskHandler } from "@pentefino/adapters";
import { resolveNow } from "../clock.js";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; writes go through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";

const { events, ruleMetrics } = schema;

export type RuleMetricsDeps = {
  db: Database;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// The three finding-level outcomes `rule_metrics` tracks that already have
// an `events` name (see the doc comment on `finding_created` in
// packages/core/src/events.ts for why that name had to be added for this
// job to exist at all). `rule_metrics.contested` and `.resolved` have no
// finding-level event yet — nothing in the catalogue names a finding
// reaching `contested`/`resolved`/`unresolved` (those are `findings.status`
// values, set by E4/E5 work not built as of this task) — so this job always
// writes them as a plain 0 rather than inventing a source for them. That is
// still a legitimate, idempotent materialisation of *this* day's honest
// total: RF-302 only requires that recomputing a day be stable, not that
// every column already have a producer.
const FIRED: EventType = "finding_created";
const DISMISSED: EventType = "finding_dismissed";
const CONFIRMED: EventType = "finding_confirmed";
const TRACKED_TYPES: EventType[] = [FIRED, DISMISSED, CONFIRMED];

/**
 * The shared `resolveNow` (`../clock.js`) turned into this job's UTC day.
 *
 * This used to re-implement the payload parsing inline. It was the third
 * copy of the same six lines, and the risk was never that one of them was
 * wrong today: it was that a job could come to accept a payload shape the
 * others reject, and nobody would notice until a date was wrong in
 * production.
 */
function resolveDay(payload: Record<string, unknown>): { start: Date; end: Date; iso: string } {
  const now = resolveNow(payload, "rule-metrics");

  // UTC day boundaries, not local time: `day` is a plain `date` column, and
  // pinning it to UTC keeps a run's result independent of the host's time
  // zone — the same day must materialise to the same row wherever the job
  // happens to execute.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + DAY_MS);
  const iso = start.toISOString().slice(0, 10);
  return { start, end, iso };
}

type RuleRef = { ruleSlug: string; ruleVersion: number };

/**
 * `events.payload` carries no schema of its own (RF-120/RF-121's rule
 * engine is pure and has no persistence step yet — see the doc comment in
 * events.ts), so this is the one place that defines the contract a
 * `finding_created`/`finding_dismissed`/`finding_confirmed` event's payload
 * must satisfy for this job to attribute it to a rule: `ruleSlug` (string)
 * and `ruleVersion` (number). An event missing either is skipped, not
 * thrown on — a malformed or legacy payload must not take down every other
 * rule's honest count for the day.
 */
function readRuleRef(payload: unknown): RuleRef | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { ruleSlug, ruleVersion } = payload as Record<string, unknown>;
  if (typeof ruleSlug !== "string" || ruleSlug.length === 0) return undefined;
  if (typeof ruleVersion !== "number" || !Number.isInteger(ruleVersion)) return undefined;
  return { ruleSlug, ruleVersion };
}

type Counters = { ruleSlug: string; ruleVersion: number; fired: number; dismissed: number; confirmed: number };

/**
 * RF-302's nightly job: materialises `rule_metrics` from `events` for one
 * day at a time.
 *
 * Deliberately a full recompute of that single day on every run, not an
 * incremental increment — the exact requirement the brief calls out
 * ("recomputing the same day must produce an identical result") only holds
 * if the job re-derives every counter from `events` from scratch each time
 * rather than adding to whatever the row already held. `onConflictDoUpdate`
 * below overwrites `fired`/`dismissed`/`confirmed`/`contested`/`resolved`
 * unconditionally instead of incrementing them, so running this twice against
 * the same immutable set of `events` rows always leaves the same numbers
 * behind — a job that instead did `SET fired = fired + $n` would double-count
 * every event on a second run for the same day, and RF-126/RF-127's
 * thresholds downstream would silently rot.
 *
 * A day with zero matching events for a given rule writes no row for it at
 * all, rather than a fabricated `fired: 0` row — nothing downstream needs a
 * placeholder, and it keeps "this rule fired on this day" answerable by a
 * row's mere existence.
 */
export function createRuleMetricsTask(deps: RuleMetricsDeps): TaskHandler {
  const { db } = deps;

  return async function materializeRuleMetrics(payload: Record<string, unknown>): Promise<void> {
    const { start, end, iso } = resolveDay(payload);

    const rows = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(and(inArray(events.type, TRACKED_TYPES), gte(events.occurredAt, start), lt(events.occurredAt, end)));

    if (rows.length === 0) return;

    const counters = new Map<string, Counters>();
    for (const row of rows) {
      const ref = readRuleRef(row.payload);
      if (!ref) continue;

      const key = `${ref.ruleSlug}@${ref.ruleVersion}`;
      const entry = counters.get(key) ?? { ...ref, fired: 0, dismissed: 0, confirmed: 0 };
      if (row.type === FIRED) entry.fired += 1;
      else if (row.type === DISMISSED) entry.dismissed += 1;
      else if (row.type === CONFIRMED) entry.confirmed += 1;
      counters.set(key, entry);
    }

    for (const entry of counters.values()) {
      await db
        .insert(ruleMetrics)
        .values({
          id: newId("rmt"),
          ruleSlug: entry.ruleSlug,
          ruleVersion: entry.ruleVersion,
          day: iso,
          fired: entry.fired,
          dismissed: entry.dismissed,
          confirmed: entry.confirmed,
          contested: 0,
          resolved: 0,
        })
        .onConflictDoUpdate({
          target: [ruleMetrics.ruleSlug, ruleMetrics.ruleVersion, ruleMetrics.day],
          set: {
            fired: entry.fired,
            dismissed: entry.dismissed,
            confirmed: entry.confirmed,
            contested: 0,
            resolved: 0,
            updatedAt: sql`now()`,
          },
        });
    }
  };
}
