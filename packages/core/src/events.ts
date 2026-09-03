/**
 * Event catalogue (PRD §15.1). Names are a contract: adding is free,
 * renaming requires migrating dashboards.
 *
 * Two additions on top of the PRD's literal transcription, both needed once
 * Task 13 built the pipeline that §9.2's state machine describes:
 *
 *   queued → extracting → validating → analyzed
 *                             └─(falha)──▶ needs_review
 *                             └─(erro fatal)─▶ failed
 *
 * `invoice_analyzed` and `invoice_failed` name the two terminal transitions
 * (`validating → analyzed`, `* → failed`) that diagram draws but that the
 * original list left unnamed. Without them A3 ("toda transição grava
 * events") would not hold for either one, and neither outcome could be
 * reconstructed from `events` alone by a metric, the adaptive engine, or an
 * audit — exactly what A3 promises they never have to do.
 *
 * `finding_created` is a third addition, needed by Task 8 (E2) for the same
 * A3 reason: RF-302's nightly job materialises `rule_metrics.fired` from
 * `events`, and RF-126/RF-127 read that column to promote or pause a rule.
 * The PRD's §15.1 list already carries the two outcomes a finding can meet
 * afterwards (`finding_dismissed`, `finding_confirmed`) but never named the
 * moment the rule engine produces the finding in the first place — without
 * it there would be no `events` row to count towards "disparos" at all, and
 * `rule_metrics.fired` would have no honest source. The engine that will
 * emit it (RF-120's `runRules`, wired to persistence) is not built yet as of
 * this task — see the doc comment on `createRuleMetricsTask` for what that
 * means for E2 today.
 *
 * `invoice_processing_started` is a fourth addition, for Task 2 (E3),
 * RF-141's SSE progress stream. Before it, the state machine above had a
 * gap of its own: `invoice_uploaded` names entering `queued` and
 * `invoice_extracted` names *finishing* extraction, but nothing named
 * entering `extracting` itself — the ingest task changed
 * `invoices.status` there with a plain `db.update`, no `events` row. A
 * poller reading a *column* can miss a value that a later write overwrites
 * before anyone reads it; a poller reading *rows* cannot, because a row
 * once written stays there to be read whenever the next poll happens to
 * run. RF-141's acceptance (at least four distinct events between `queued`
 * and `analyzed`) has to hold regardless of how fast validation and
 * persistence run after extraction returns, so it has to be built on the
 * second kind of read — which meant this transition needed the row
 * `invoice_uploaded`/`invoice_extracted`/`invoice_analyzed` already had.
 *
 * `case_stalled` is a fifth addition, for Task 3 (E5), RF-186's first
 * window. It exists because §9.1's `stalled` is the one state in this
 * system that has nowhere else to be recorded. §9.1 calls it a *sub-estado*
 * that "volta a sac"; `STAGES` does not contain it and the
 * `cases_stage_values` CHECK constraint rejects it, so it can never be a
 * `cases.stage` value — and in the common case it is reached from (`sac`
 * with no protocol after 30 days) the stage does not change at all, so no
 * `stage_advanced` is written either. Without this name, "30 days passed
 * and nobody ever wrote to the channel" leaves *zero* trace: A3 ("toda
 * transição grava events") would not hold for it, and neither the case
 * timeline (`GET /api/cases/:id`) nor RF-185's final reminder could tell a
 * stalled case from one nothing has happened to yet.
 *
 * Its sibling `abandoned` deliberately did **not** get a name of its own.
 * An abandonment closes the case, so it already writes a `stage_advanced`
 * to `closed` carrying `outcome: "abandoned"`, plus `cases.outcome` and
 * `cases.closed_at`. A `case_abandoned` event would be a second, redundant
 * record of a transition that is already fully readable — and renaming is
 * what costs, so a name that adds nothing should not be added.
 */
export const EVENTS = [
  "invoice_uploaded", "invoice_processing_started", "invoice_extracted", "invoice_analyzed",
  "invoice_needs_review", "invoice_failed",
  // RF-110's daily expiry job (Task 9, E1) needs its own pair for the same
  // reason invoice_analyzed/invoice_failed exist: the file's deletion (or a
  // storage failure that must not silently repeat forever) is a real state
  // transition on the invoice row that A3 requires be readable from `events`
  // alone, not just inferred from `file_key` going null.
  "invoice_file_expired", "invoice_file_expiry_failed",
  "report_viewed", "finding_created", "finding_dismissed", "finding_confirmed",
  "card_shared", "public_report_viewed",
  "case_created", "contest_generated", "contest_edited", "contest_marked_sent",
  // `response_received` is E5 Task 5's addition (§15.1: "Adicionar é
  // livre"). §9.1's machine already answers to a `response_received`
  // `StageEvent` - it is what clears the wait, because the wait existed to
  // detect silence and the channel has now spoken - but the catalogue had no
  // name for it, so nothing could record that it happened. Without the row,
  // a case's trail shows a deadline that simply stops, with no way to tell
  // "the company answered" from "somebody cleared the column", and E6's diff
  // has no anchor for when the answer arrived. The pair it completes is
  // `protocol_entered` (the person wrote to the channel) and this (the
  // channel wrote back).
  "protocol_entered", "response_received", "stage_advanced", "deadline_expired",
  "case_stalled",
  "diff_run", "outcome_confirmed", "case_reopened",
  "monitor_email_received", "monthly_digest_sent",
  "session_claimed", "subscription_started", "subscription_failed",
  "rule_promoted", "rule_paused", "proposal_created", "proposal_decided",
  // `rule_version_created`, `rule_version_activated` and
  // `rule_version_superseded` are Task 1 (E11)'s addition, for RF-301's
  // admin CRUD ("editar cria nova versão, a anterior vira histórico") -
  // global constraint 6 makes `rules` rows append-only in content, so every
  // edit an admin makes is a brand-new `(slug, version)` row, never a
  // mutation of an old one, and each of the three moments that sentence
  // describes is a real state transition A3 ("toda transição grava events")
  // requires be readable from `events` alone: a version being written
  // (`rule_version_created`), a version becoming the one the engine actually
  // evaluates (`rule_version_activated` - distinct from the existing
  // `rule_promoted`, which names a single row's own shadow-to-active status
  // flip, not a new row appearing), and the version it replaced stepping
  // aside (`rule_version_superseded`). Without these three, "a rule's
  // content changed" would leave no trace at all - only the pre-existing
  // status transition on a single row would remain visible.
  //
  // A manual pause does not get a fourth name here: pausing is not a new
  // version, it is the existing `status` column flipping on the same row
  // (`rule-lifecycle.ts`'s `setStatus`), and `rule_paused` already names
  // that transition.
  "rule_version_created", "rule_version_activated", "rule_version_superseded",
  // RF-187's dossier job (Task 7, E5), for the same A3 reason as the pair
  // above: producing the JEC dossier is a real transition on the case - the
  // moment it becomes something a person can take to a Juizado - and it has
  // to be readable from `events` alone, not inferred from an object sitting
  // in storage. It is also the job's own idempotency guard: the absence of a
  // `dossier_generated` row for a case is what makes it eligible, so a
  // second run can neither produce a second PDF nor a second event.
  // `dossier_generation_failed` exists for exactly the reason
  // `invoice_file_expiry_failed` does: a per-case failure is isolated and
  // retried on the next run, and a failure that silently repeats forever
  // must still be visible to anyone reading the event stream.
  "dossier_generated", "dossier_generation_failed",
  // RF-185 (Task 6, E5) wants reminders suppressed if the person opened the
  // case in the last 24 hours, which needs a recorded "opened" fact to read.
  // `report_viewed` was considered and cannot serve: it names the laudo, not
  // the case - a person can read a laudo without ever opening the case
  // screen, and can open a case screen for an invoice whose laudo they read
  // months ago, so neither observation implies the other. Unlike every other
  // addition in this file, `case_viewed` is honestly *not* an A3 state
  // transition - nothing about the case changes when someone looks at it. It
  // is admitted to the catalogue anyway because RF-185's suppression is a
  // product requirement that can only be met by a durable record, and
  // `events` is the only durable append-only record this system has;
  // without this name, "was this case looked at recently" has no honest
  // source to read it from, and the suppression stays unbuildable.
  "case_viewed",
  // `case_reminder_sent` is the seventh addition, for E5's RF-185. Unlike
  // `case_viewed` this one *is* an A3 fact about the case: the product
  // reached out to the person on a date, through a channel, about a reason.
  //
  // It exists because a reminder has to be idempotent across sweeps. The
  // job runs on a clock; without a row saying "this case was already
  // reminded about this stall", every run would send the same e-mail again,
  // and a product that mails you daily about one thing is a product you
  // mute — after which no reminder reaches you at all, which is the failure
  // RF-185's suppression rule already exists to prevent.
  //
  // It is also the only durable record that the person was told. RF-186
  // gives a stalled case "um lembrete final" before closing it 30 days
  // later, and a case closed as abandoned should be able to show it warned
  // its owner first — RF-187's dossier and any support conversation both
  // need that to be a fact rather than an assumption.
  "case_reminder_sent",
  // RF-245's aggregate-base consent (Task 1, E8). `users.aggregate_consent_at`
  // only ever holds the current answer - a timestamp or NULL - so neither
  // value alone can show that a *withdrawal* happened: NULL means either
  // "never granted" or "granted, then taken back", and those are different
  // facts for anyone auditing consent later. Both directions need a name
  // for the same A3 reason `protocol_entered`/`response_received` do - a
  // column is a snapshot, and a snapshot cannot reconstruct the history of
  // even two changes to it.
  "consent_granted", "consent_withdrawn",
  // `account_deletion_requested` (Task 1, E8) names the moment the person
  // actually asked. §13.2's "exclusão em andamento" state has to be
  // readable from somewhere durable - `users.deleted_at` being set is the
  // *current* fact, but says nothing about when it was set - and RF-243
  // promises the purge completes within 24 hours of that moment, so the
  // purge job needs this row's `occurred_at` to report how long a run took
  // against that promise.
  "account_deletion_requested",
  // `account_deleted` is RF-243's audit event, and the one row in this
  // whole catalogue that is *designed* to survive the deletion it records.
  // The purge removes every other trace of the account - rows, files,
  // everything derived - so this event has to carry no PII to protect:
  // `user_id` is NULL on the row, and the payload holds a hashed user id,
  // never the real one, while still proving to anyone who asks later that
  // the deletion happened and when.
  "account_deleted",
  // Same reason `invoice_file_expiry_failed` exists: purging one account is
  // a per-subject operation, and a per-subject failure that silently
  // repeats forever - never surfacing, never getting fixed - must still be
  // visible to whoever reads the event stream. `account_purge_failed`
  // fills that role for the deletion job; the subject stays eligible for
  // the next run, same as expire-files.ts's precedent.
  "account_purge_failed",
  // RF-242's export. `data_exported` is what lets a later question -
  // "did somebody else download my data?" - have an answer. An export
  // hands over a complete copy of everything the person has; if the
  // session that requested it is later found to have been compromised,
  // this event is the only trace that the copy was ever made, and when.
  "data_exported",
] as const;

export type EventType = (typeof EVENTS)[number];
