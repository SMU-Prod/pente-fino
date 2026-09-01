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
 */
export const EVENTS = [
  "invoice_uploaded", "invoice_extracted", "invoice_analyzed",
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
  "protocol_entered", "stage_advanced", "deadline_expired",
  "diff_run", "outcome_confirmed", "case_reopened",
  "monitor_email_received", "monthly_digest_sent",
  "session_claimed", "subscription_started", "subscription_failed",
  "rule_promoted", "rule_paused", "proposal_created", "proposal_decided",
] as const;

export type EventType = (typeof EVENTS)[number];
