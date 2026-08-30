/**
 * Event catalogue (PRD §15.1). Names are a contract: adding is free,
 * renaming requires migrating dashboards.
 */
export const EVENTS = [
  "invoice_uploaded", "invoice_extracted", "invoice_needs_review",
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
