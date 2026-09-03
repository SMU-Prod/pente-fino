import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import {
  newId, SAO_PAULO_UTC_OFFSET_MINUTES, validateRuleDraft,
  type EventType, type RuleDraftInput, type RuleDraftProblem,
} from "@pentefino/core";
import type { Database } from "./client.js";
import { agentProposals, aiCalls, cases, events, findings, invoices, ruleMetrics, rules, seoPages, users } from "./schema.js";

/**
 * The admin panel's data layer (RF-300/RF-301, block E11). Every function
 * here takes `db: Database` explicitly and has no session to scope by, for
 * the same reason `case-close.ts`'s `closeCaseAsSystem` does not go through
 * `withUser`: rules, proposals and the overview counters are system
 * configuration, not one person's data, so there is no `userId` or
 * `sessionId` to filter on and INV-008 has nothing to say about them.
 * `apps/web/lib/container.ts` shows the established shape for a caller
 * outside this package that legitimately needs a system-scoped import.
 *
 * Two invariants hold across this whole file, not just one function:
 *
 *   - **Rules are append-only in content** (global constraint 6). No
 *     function here ever runs `UPDATE rules SET spec = ...` (or
 *     `legalBasis`/`confidenceBase`/`category`/`kind`/`slug`/`reason`/
 *     `author`) against an existing row. `createRuleVersion` only ever
 *     INSERTs a new `(slug, version)` row; `activateRuleVersion` and
 *     `pauseRuleVersion` only ever touch `status`/`shadowUntil`.
 *   - **There is exactly one promotion path** (global constraint 7):
 *     `applyRulePromotionProposal` in `apps/jobs/src/tasks/rule-lifecycle.ts`
 *     is the only function in this codebase allowed to set
 *     `rules.status = 'active'`. Nothing in this file ever writes
 *     `"active"` — `activateRuleVersion` moves `draft` to `shadow`, never
 *     further, and `test/admin.test.ts` pins that with a grep over this
 *     file's own source.
 */

// ---------------------------------------------------------------------------
// adminAccount
// ---------------------------------------------------------------------------

/**
 * Reads a `users` row by id for the identity gate (Task 3): a soft-deleted
 * account (`deletedAt` set) reads as absent, the same way a missing row
 * does, so a stale admin session against a since-deleted account cannot
 * authenticate. Returns only the two fields an identity check needs, never
 * the whole row — this function is not a general-purpose user lookup.
 */
export async function adminAccount(db: Database, userId: string): Promise<{ id: string; email: string } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!row || row.deletedAt !== null) return null;
  return { id: row.id, email: row.email };
}

// ---------------------------------------------------------------------------
// createRuleVersion
// ---------------------------------------------------------------------------

/**
 * Carries `validateRuleDraft`'s problems out of `createRuleVersion` as a
 * real `Error` subclass, so a caller (Task 4's route handler) can catch one
 * specific type and read `.problems` back out for a 4xx response, instead of
 * pattern-matching on a generic `Error.message` string.
 */
export class RuleDraftError extends Error {
  readonly problems: RuleDraftProblem[];

  constructor(problems: RuleDraftProblem[]) {
    super(`rule draft rejected: ${problems.map((p) => `${p.field} (${p.code})`).join("; ")}`);
    this.name = "RuleDraftError";
    this.problems = problems;
  }
}

export type CreateRuleVersionResult = { id: string; slug: string; version: number };

/**
 * RF-301's admin CRUD: "editar cria nova versão, a anterior vira histórico".
 * `input` is exactly a `RuleDraftInput` — there is no field that lets a
 * caller choose a status, because RF-125 fixes it: every new version is born
 * `draft`, `shadowUntil` is always `null`, and `activateRuleVersion` is the
 * only draft→shadow move (see this module's header for the rest of the
 * lifecycle).
 *
 * `validateRuleDraft` (Task 1, `@pentefino/core`) runs first; any problem it
 * finds throws a `RuleDraftError` before anything is read or written.
 *
 * INV-010, as this task applies it: a `suppressor` exists to permanently
 * silence a dead thesis, and RF-301's own versioning would otherwise let an
 * admin quietly turn one into a detection rule by "editing" it — a new
 * version under the same slug, with a different `kind`. So when the slug's
 * current version is a suppressor, every later version must stay one; this
 * is checked here (not in `validateRuleDraft`, which knows nothing about
 * what already exists in the database) and reported through the same
 * `RuleDraftError` shape.
 *
 * The version number is computed, never supplied: `max(version) + 1` for an
 * existing slug, `1` for a new one, both read inside the same transaction
 * that performs the insert. This is a pure INSERT — the predecessor row (if
 * any) is read for its `version`/`kind` and never written to.
 */
export async function createRuleVersion(db: Database, input: RuleDraftInput): Promise<CreateRuleVersionResult> {
  const validation = validateRuleDraft(input);
  if (!validation.ok) throw new RuleDraftError(validation.problems);

  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ version: rules.version, kind: rules.kind })
      .from(rules)
      .where(eq(rules.slug, input.slug))
      .orderBy(desc(rules.version))
      .limit(1);

    if (previous && previous.kind === "suppressor" && input.kind !== "suppressor") {
      throw new RuleDraftError([{
        field: "kind",
        code: "suppressor_kind_locked",
        message:
          `A versão atual de "${input.slug}" é um supressor; uma nova versão não pode mudar o tipo ` +
          `para "${input.kind}" (INV-010).`,
      }]);
    }

    const version = previous ? previous.version + 1 : 1;
    const id = newId("rul");

    await tx.insert(rules).values({
      id,
      slug: input.slug,
      version,
      category: input.category,
      issuerId: input.issuerId,
      kind: input.kind,
      spec: input.spec,
      legalBasis: input.legalBasis,
      confidenceBase: input.confidenceBase,
      status: "draft",
      shadowUntil: null,
      author: input.author,
      reason: input.reason,
    });

    await tx.insert(events).values({
      id: newId("evt"),
      type: "rule_version_created" satisfies EventType,
      payload: {
        ruleId: id,
        ruleSlug: input.slug,
        ruleVersion: version,
        previousVersion: previous?.version ?? null,
        author: input.author,
      },
    });

    return { id, slug: input.slug, version };
  });
}

// ---------------------------------------------------------------------------
// activateRuleVersion
// ---------------------------------------------------------------------------

export type ActivateRuleVersionInput = { ruleId: string; actor: string; now?: Date };

const SEVEN_DAYS_MILLIS = 7 * 24 * 60 * 60 * 1000;

/**
 * RF-125's "ao ser ativada entra em shadow por 7 dias" — the only place in
 * this codebase that moves a rule `draft` → `shadow`. Refuses (throws)
 * unless the row's current status is exactly `draft`: an already-`shadow`
 * or `active` row has nothing left for this function to do, and silently
 * no-op-ing would hide that from a caller expecting a real transition.
 *
 * `now` is injectable (`{ now?: Date }`), defaulting to the real clock, the
 * same convention `apps/jobs/src/clock.ts`'s `resolveNow` establishes for
 * every scheduled task in this repo — a test asserting "exactly 7 days from
 * now" cannot depend on the wall clock without becoming flaky.
 *
 * The row is read under `FOR UPDATE` first so the refusal message can name
 * the actual status a concurrent caller left it in, and so two admins
 * clicking "activate" on the same rule cannot both succeed.
 */
export async function activateRuleVersion(db: Database, input: ActivateRuleVersionInput): Promise<void> {
  const now = input.now ?? new Date();
  const shadowUntil = new Date(now.getTime() + SEVEN_DAYS_MILLIS);

  await db.transaction(async (tx) => {
    const [rule] = await tx.select().from(rules).where(eq(rules.id, input.ruleId)).for("update");
    if (!rule) {
      throw new Error(`admin: no rules row with id ${input.ruleId}`);
    }
    if (rule.status !== "draft") {
      throw new Error(`admin: rule ${input.ruleId} is "${rule.status}", not "draft" — refusing to activate`);
    }

    await tx.update(rules).set({ status: "shadow", shadowUntil }).where(eq(rules.id, input.ruleId));

    await tx.insert(events).values({
      id: newId("evt"),
      type: "rule_version_activated" satisfies EventType,
      payload: {
        ruleId: rule.id,
        ruleSlug: rule.slug,
        ruleVersion: rule.version,
        actor: input.actor,
        shadowUntil: shadowUntil.toISOString(),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// pauseRuleVersion
// ---------------------------------------------------------------------------

export type PauseRuleVersionInput = { ruleId: string; actor: string; reason: string };

/**
 * A human's off-switch for a rule that is `active` or `shadow` — refuses
 * (throws) for any other status, since there is nothing running left to
 * pause. **This function may never promote a rule back to the running
 * status** — see this module's header; the only transition here is to
 * `paused`.
 *
 * Deliberately reuses `rule_paused` — the same event name
 * `apps/jobs/src/tasks/rule-lifecycle.ts`'s automatic RF-127 pause writes —
 * rather than inventing a second one. §15.3's "Regra ruim" alert watches
 * `type = 'rule_paused'` on `events`' `byTypeTime` index, and a rule a human
 * switched off is exactly as much "this rule stopped running" as one the
 * job switched off on its own; that alert should fire either way. What
 * distinguishes the two is the payload, not the event name:
 * `decidedBy`'s **presence** here is what says a person made this call,
 * where the automatic pause's payload never carries it at all.
 */
export async function pauseRuleVersion(db: Database, input: PauseRuleVersionInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [rule] = await tx.select().from(rules).where(eq(rules.id, input.ruleId)).for("update");
    if (!rule) {
      throw new Error(`admin: no rules row with id ${input.ruleId}`);
    }
    if (rule.status !== "active" && rule.status !== "shadow") {
      throw new Error(
        `admin: rule ${input.ruleId} is "${rule.status}", not "active" or "shadow" — refusing to pause`,
      );
    }

    await tx.update(rules).set({ status: "paused" }).where(eq(rules.id, input.ruleId));

    await tx.insert(events).values({
      id: newId("evt"),
      type: "rule_paused" satisfies EventType,
      payload: {
        ruleId: rule.id,
        ruleSlug: rule.slug,
        ruleVersion: rule.version,
        decidedBy: input.actor,
        decisionReason: input.reason,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// listRuleFamilies
// ---------------------------------------------------------------------------

export type RuleVersionMetrics = {
  fired: number;
  dismissed: number;
  confirmed: number;
  contested: number;
  resolved: number;
};

export type RuleFamilyVersion = typeof rules.$inferSelect & {
  metrics: RuleVersionMetrics;
  hasPendingPromotionProposal: boolean;
};

export type RuleFamily = { slug: string; versions: RuleFamilyVersion[] };

const ZERO_METRICS: RuleVersionMetrics = { fired: 0, dismissed: 0, confirmed: 0, contested: 0, resolved: 0 };

/**
 * Every `rules` row, grouped by `slug` and sorted newest-version-first,
 * carrying two things no single table has on its own:
 *
 *   - cumulative `rule_metrics` totals for that exact `(ruleSlug,
 *     ruleVersion)` pair, summed across every `day` row on record — the same
 *     cumulative-not-daily totals `rule-lifecycle.ts`'s `totalsFor` reads to
 *     decide promotion/pause, so the admin screen shows the same numbers the
 *     job actually acts on;
 *   - whether that exact version has a `pending` `promote_rule` proposal
 *     waiting on it, read from `agent_proposals.target` (which
 *     `proposeRulePromotion` always sets to the rule's own `id`).
 *
 * Summed in JS off two flat `SELECT`s rather than a SQL `GROUP BY`, the same
 * shape `totalsFor` already uses in this codebase — `rule_metrics` has one
 * row per `(slug, version, day)`, so the aggregation is a handful of numbers
 * over a small table, not a query worth pushing into the database.
 */
export async function listRuleFamilies(db: Database): Promise<RuleFamily[]> {
  const [allRules, metricsRows, pendingRows] = await Promise.all([
    db.select().from(rules),
    db
      .select({
        ruleSlug: ruleMetrics.ruleSlug,
        ruleVersion: ruleMetrics.ruleVersion,
        fired: ruleMetrics.fired,
        dismissed: ruleMetrics.dismissed,
        confirmed: ruleMetrics.confirmed,
        contested: ruleMetrics.contested,
        resolved: ruleMetrics.resolved,
      })
      .from(ruleMetrics),
    db
      .select({ target: agentProposals.target })
      .from(agentProposals)
      .where(and(eq(agentProposals.kind, "promote_rule"), eq(agentProposals.status, "pending"))),
  ]);

  const metricsByKey = new Map<string, RuleVersionMetrics>();
  for (const row of metricsRows) {
    const key = `${row.ruleSlug} ${row.ruleVersion}`;
    const totals = metricsByKey.get(key) ?? { ...ZERO_METRICS };
    totals.fired += row.fired;
    totals.dismissed += row.dismissed;
    totals.confirmed += row.confirmed;
    totals.contested += row.contested;
    totals.resolved += row.resolved;
    metricsByKey.set(key, totals);
  }

  const pendingRuleIds = new Set(pendingRows.map((row) => row.target));

  const versionsBySlug = new Map<string, RuleFamilyVersion[]>();
  for (const rule of allRules) {
    const key = `${rule.slug} ${rule.version}`;
    const version: RuleFamilyVersion = {
      ...rule,
      metrics: metricsByKey.get(key) ?? ZERO_METRICS,
      hasPendingPromotionProposal: pendingRuleIds.has(rule.id),
    };
    const versions = versionsBySlug.get(rule.slug) ?? [];
    versions.push(version);
    versionsBySlug.set(rule.slug, versions);
  }

  const families = [...versionsBySlug.entries()].map(([slug, versions]) => ({
    slug,
    versions: versions.sort((a, b) => b.version - a.version),
  }));
  families.sort((a, b) => a.slug.localeCompare(b.slug));
  return families;
}

// ---------------------------------------------------------------------------
// listProposals / rejectProposal
// ---------------------------------------------------------------------------

export type ProposalRow = typeof agentProposals.$inferSelect;

/** Every `agent_proposals` row, newest first; `pending`-only unless `includeDecided`. */
export async function listProposals(db: Database, input: { includeDecided: boolean }): Promise<ProposalRow[]> {
  if (input.includeDecided) {
    return db.select().from(agentProposals).orderBy(desc(agentProposals.createdAt));
  }
  return db
    .select()
    .from(agentProposals)
    .where(eq(agentProposals.status, "pending"))
    .orderBy(desc(agentProposals.createdAt));
}

export type RejectProposalInput = { proposalId: string; decidedBy: string; decisionReason: string };

/**
 * The rejection half of a human deciding an `agent_proposals` row — the
 * mirror image of `applyRulePromotionProposal`'s approval in
 * `apps/jobs/src/tasks/rule-lifecycle.ts`, refusing in the same style
 * (throwing with a message naming the id and the actual status) for the
 * same reason: a decided proposal is not re-decidable through this path,
 * since re-running it would let a second, possibly-conflicting
 * `decidedBy`/`decisionReason` overwrite the decision that was actually
 * acted on.
 *
 * **Changes no rule.** Unlike approval, rejection has no effect on
 * `rules` at all — the row this proposal names (if any) is left exactly as
 * it was, which is the entire point of a reject button: "no" is a decision
 * about the proposal, not about the thing it proposed.
 */
export async function rejectProposal(db: Database, input: RejectProposalInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, input.proposalId))
      .for("update");
    if (!proposal) {
      throw new Error(`admin: no agent_proposals row with id ${input.proposalId}`);
    }
    if (proposal.status !== "pending") {
      throw new Error(`admin: agent_proposals ${input.proposalId} is already "${proposal.status}", not pending`);
    }

    await tx
      .update(agentProposals)
      .set({ status: "rejected", decidedBy: input.decidedBy, decisionReason: input.decisionReason })
      .where(eq(agentProposals.id, input.proposalId));

    await tx.insert(events).values({
      id: newId("evt"),
      type: "proposal_decided" satisfies EventType,
      payload: {
        proposalId: input.proposalId,
        kind: proposal.kind,
        target: proposal.target,
        decidedBy: input.decidedBy,
        decisionReason: input.decisionReason,
        status: "rejected",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// adminOverview
// ---------------------------------------------------------------------------

export type AdminOverview = {
  invoicesToday: Record<string, number>;
  aiCostToday: { calls: number; costUsd: number };
  stalledCases: number;
  shadowFindings: number;
  seoPages: Record<string, number>;
};

const MILLIS_PER_DAY = 86_400_000;
const MILLIS_PER_MINUTE = 60_000;

/**
 * The UTC instant that is local midnight, `America/Sao_Paulo`, for the day
 * `instant` falls on. Built from the single timezone constant this repo
 * declares (`SAO_PAULO_UTC_OFFSET_MINUTES`, `packages/core/src/cases/
 * deadline.ts` — CLAUDE.md §8.1 forbids a second one) using the identical
 * floor-to-day arithmetic `toCivilDate` documents there: local wall-clock
 * millis, floored to the day, then converted back to a UTC instant at that
 * day's start. `deadline.ts`'s own `endOfCivilDay` computes the same day's
 * *last* millisecond for a different purpose (a deadline's expiry); this is
 * its mirror image, the day's *first* millisecond, for "since local
 * midnight" windows like RF-300's "faturas do dia".
 */
function startOfLocalDayUtc(instant: Date): Date {
  const offsetMillis = SAO_PAULO_UTC_OFFSET_MINUTES * MILLIS_PER_MINUTE;
  const epochDay = Math.floor((instant.getTime() + offsetMillis) / MILLIS_PER_DAY);
  return new Date(epochDay * MILLIS_PER_DAY - offsetMillis);
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * RF-300's admin overview: **counts and aggregates only** (global constraint
 * 5). Nothing this function returns carries an invoice's canonical, an item
 * description, a finding's evidence text, an e-mail address or a case
 * document's body — every field below is a number, or a status-keyed map of
 * numbers.
 *
 * `now` is required, not defaulted: every count below is relative to it
 * (`invoicesToday`/`aiCostToday`'s "since local midnight", `stalledCases`'s
 * "in the past"), so a caller must be explicit about what instant "today"
 * means, the same discipline `closeCaseAsSystem`'s injectable `at` and
 * RF-186's simulated-clock tests already apply elsewhere in this package.
 *
 * Every query here degrades to zero on an empty table rather than throwing
 * — including `seo_pages`, which E10 has not populated yet.
 */
export async function adminOverview(db: Database, input: { now: Date }): Promise<AdminOverview> {
  const midnight = startOfLocalDayUtc(input.now);

  const [invoiceRows, aiCallRows, stalledRows, shadowRows, seoRows] = await Promise.all([
    db.select({ status: invoices.status }).from(invoices).where(gte(invoices.createdAt, midnight)),
    db.select({ costUsd: aiCalls.costUsd }).from(aiCalls).where(gte(aiCalls.createdAt, midnight)),
    db
      .select({ id: cases.id })
      .from(cases)
      .where(and(ne(cases.stage, "closed"), lt(cases.nextDeadlineAt, input.now))),
    db.select({ id: findings.id }).from(findings).where(eq(findings.shadow, true)),
    db.select({ status: seoPages.status }).from(seoPages),
  ]);

  const aiCostToday = aiCallRows.reduce<{ calls: number; costUsd: number }>(
    (acc, row) => ({ calls: acc.calls + 1, costUsd: acc.costUsd + row.costUsd }),
    { calls: 0, costUsd: 0 },
  );

  return {
    invoicesToday: tally(invoiceRows.map((row) => row.status)),
    aiCostToday,
    stalledCases: stalledRows.length,
    shadowFindings: shadowRows.length,
    seoPages: tally(seoRows.map((row) => row.status)),
  };
}
