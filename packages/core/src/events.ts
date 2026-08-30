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
 */
export const EVENTS = [
  "invoice_uploaded", "invoice_extracted", "invoice_analyzed",
  "invoice_needs_review", "invoice_failed",
  "report_viewed", "finding_dismissed", "finding_confirmed",
  "card_shared", "public_report_viewed",
  "case_created", "contest_generated", "contest_edited", "contest_marked_sent",
  "protocol_entered", "stage_advanced", "deadline_expired",
  "diff_run", "outcome_confirmed", "case_reopened",
  "monitor_email_received", "monthly_digest_sent",
  "session_claimed", "subscription_started", "subscription_failed",
  "rule_promoted", "rule_paused", "proposal_created", "proposal_decided",
] as const;

export type EventType = (typeof EVENTS)[number];
