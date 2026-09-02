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
  "diff_run", "outcome_confirmed", "case_reopened",
  "monitor_email_received", "monthly_digest_sent",
  "session_claimed", "subscription_started", "subscription_failed",
  "rule_promoted", "rule_paused", "proposal_created", "proposal_decided",
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
] as const;

export type EventType = (typeof EVENTS)[number];
