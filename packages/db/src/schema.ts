// Transcribed from PRD.md §6.2, verbatim in column names, types, defaults,
// and indexes. Two additions on top, both required by §6.1 but omitted by
// §6.2's prose:
//
//   (a) a `check()` CHECK constraint for every text column that models an
//       enum (§6.1: "Enums: text com CHECK, não enum nativo"). This covers
//       every enum-shaped column, including `rules.category` (same domain
//       as `issuers.category`) and `case_documents.stage` /
//       `case_protocols.stage` (same domain as `cases.stage`, per §7.4's
//       Stage set: draft, sac, ombudsman, consumidor_gov, regulator,
//       procon, jec_ready, closed).
//   (b) `created_at` and `updated_at` on every table (§6.1: "Toda tabela:
//       created_at, updated_at"). `events` is the sole exception: an event
//       is immutable by definition, so it keeps only `occurred_at`.
//
// `invoices.status` also gains `validating` in its CHECK: §6.2's inline
// comment omits it, but §9.2's invoice state machine
// (queued → extracting → validating → analyzed) requires it, and the state
// machine is normative for states.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  Category,
  ContestDocument,
  InvoiceCanonical,
  LegalRef,
  Playbook,
  RuleSpec,
  Stage,
} from "@pentefino/core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  plan: text("plan").notNull().default("free"), // free | premium
  emailForwardToken: text("email_forward_token").unique(), // u-3f9a → inbound
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  planValues: check("users_plan_values", sql`${t.plan} in ('free','premium')`),
}));

export const anonymousSessions = pgTable("anonymous_sessions", {
  id: text("id").primaryKey(),
  claimedByUserId: text("claimed_by_user_id").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const issuers = pgTable("issuers", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(), // "claro-movel"
  category: text("category").notNull().$type<Category>(), // telecom|card|energy|water
  displayName: text("display_name").notNull(),
  cnpj: text("cnpj"),
  aliases: jsonb("aliases").$type<string[]>().default([]), // para detecção
  // The section names this issuer files its add-on charges under (PRD
  // §20.1). E2's pattern rules anchor on these to scope a rule to the
  // right part of the invoice instead of matching anywhere in it.
  sections: jsonb("sections").$type<string[]>().default([]),
  playbook: jsonb("playbook").$type<Playbook>(), // §7.4
  status: text("status").notNull().default("active"), // active|unknown|paused
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  categoryValues: check("issuers_category_values", sql`${t.category} in ('telecom','card','energy','water')`),
  statusValues: check("issuers_status_values", sql`${t.status} in ('active','unknown','paused')`),
}));

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  sessionId: text("session_id").references(() => anonymousSessions.id),
  issuerId: text("issuer_id").references(() => issuers.id),
  contentHash: text("content_hash").notNull(),
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  dueDate: date("due_date"),
  totalCents: integer("total_cents"),
  source: text("source").notNull(), // pdf_text|pdf_vision|photo|csv|email
  extractionQuality: real("extraction_quality"),
  status: text("status").notNull().default("queued"), // queued|extracting|validating|analyzed|needs_review|failed
  fileKey: text("file_key"),
  fileExpiresAt: timestamp("file_expires_at", { withTimezone: true }),
  canonical: jsonb("canonical").$type<InvoiceCanonical>(),
  masked: boolean("masked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerHash: uniqueIndex("invoices_owner_hash")
    .on(sql`coalesce(${t.userId}, ${t.sessionId})`, t.contentHash),
  byUserIssuer: index("invoices_user_issuer_period").on(t.userId, t.issuerId, t.periodStart),
  sourceValues: check("invoices_source_values", sql`${t.source} in ('pdf_text','pdf_vision','photo','csv','email')`),
  statusValues: check(
    "invoices_status_values",
    sql`${t.status} in ('queued','extracting','validating','analyzed','needs_review','failed')`,
  ),
}));

export const invoiceItems = pgTable("invoice_items", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  lineNo: integer("line_no").notNull(),
  // A stable hash over the item's own identity (section, description,
  // periodRef, amount) plus an occurrence index for duplicate lines - see
  // the unique index comment below. `lineNo` stays for ordering/display
  // only; it is no longer part of any uniqueness constraint.
  itemKey: text("item_key").notNull(),
  section: text("section"),
  description: text("description").notNull(),
  normalizedDesc: text("normalized_desc").notNull(),
  amountCents: integer("amount_cents").notNull(),
  qty: real("qty"),
  unitPriceCents: integer("unit_price_cents"),
  periodRef: text("period_ref"),
  meta: jsonb("meta").$type<Record<string, string | number>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byInvoiceDesc: index("items_invoice_desc").on(t.invoiceId, t.normalizedDesc),
  trgm: index("items_desc_trgm").using("gin", sql`${t.normalizedDesc} gin_trgm_ops`),
  // Lets the ingest job re-run without deleting and reinserting a row: a
  // line's (invoiceId, itemKey) is stable across re-extraction of the same
  // invoice - unlike position-derived lineNo, it does not shift when a
  // re-extraction finds a section reordered or inserted ahead of an
  // existing one - so a rerun can UPSERT onto it instead. That matters
  // because `findings.itemId` carries `onDelete: "cascade"` - a
  // delete-then-reinsert strategy would silently destroy any finding
  // already recorded against the old row the moment a step is retried, and
  // keying on position alone (the former `(invoiceId, lineNo)` index) let a
  // reordering rerun silently overwrite an unrelated row's content while
  // keeping its id.
  uniqInvoiceItemKey: uniqueIndex("items_invoice_key").on(t.invoiceId, t.itemKey),
}));

export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  version: integer("version").notNull().default(1),
  category: text("category").notNull().$type<Category>(),
  issuerId: text("issuer_id").references(() => issuers.id), // null = genérica
  kind: text("kind").notNull(), // pattern|delta|threshold|reference|confirm|arithmetic|suppressor
  spec: jsonb("spec").$type<RuleSpec>().notNull(),
  legalBasis: jsonb("legal_basis").$type<LegalRef[]>().notNull().default([]),
  confidenceBase: real("confidence_base").notNull(),
  status: text("status").notNull().default("draft"), // draft|shadow|active|paused
  shadowUntil: timestamp("shadow_until", { withTimezone: true }),
  author: text("author").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugVersion: uniqueIndex("rules_slug_version").on(t.slug, t.version),
  categoryValues: check("rules_category_values", sql`${t.category} in ('telecom','card','energy','water')`),
  kindValues: check(
    "rules_kind_values",
    sql`${t.kind} in ('pattern','delta','threshold','reference','confirm','arithmetic','suppressor')`,
  ),
  statusValues: check("rules_status_values", sql`${t.status} in ('draft','shadow','active','paused')`),
}));

export const findings = pgTable("findings", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  itemId: text("item_id").references(() => invoiceItems.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull().references(() => rules.id),
  ruleVersion: integer("rule_version").notNull(),
  confidence: real("confidence").notNull(),
  evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
  amountCents: integer("amount_cents").notNull(),
  doubledCents: integer("doubled_cents"),
  shadow: boolean("shadow").notNull().default(false),
  status: text("status").notNull().default("open"),
  // open|confirmed_by_user|dismissed_by_user|contested|resolved|unresolved
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusValues: check(
    "findings_status_values",
    sql`${t.status} in ('open','confirmed_by_user','dismissed_by_user','contested','resolved','unresolved')`,
  ),
}));

export const cases = pgTable("cases", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  issuerId: text("issuer_id").notNull().references(() => issuers.id),
  findingIds: jsonb("finding_ids").$type<string[]>().notNull(),
  stage: text("stage").notNull().default("draft").$type<Stage>(), // §9.1
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
  nextDeadlineAt: timestamp("next_deadline_at", { withTimezone: true }),
  workflowRunId: text("workflow_run_id"),
  protocolToken: text("protocol_token"), // wait.forToken
  outcome: text("outcome"), // resolved|partial|denied|abandoned
  outcomeConfirmedBy: text("outcome_confirmed_by"), // diff|user|none
  recoveredCents: integer("recovered_cents"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dueSoon: index("cases_next_deadline")
    .on(t.nextDeadlineAt).where(sql`${t.stage} <> 'closed'`),
  stageValues: check(
    "cases_stage_values",
    sql`${t.stage} in ('draft','sac','ombudsman','consumidor_gov','regulator','procon','jec_ready','closed')`,
  ),
  outcomeValues: check("cases_outcome_values", sql`${t.outcome} in ('resolved','partial','denied','abandoned')`),
  outcomeConfirmedByValues: check(
    "cases_outcome_confirmed_by_values",
    sql`${t.outcomeConfirmedBy} in ('diff','user','none')`,
  ),
}));

export const caseDocuments = pgTable("case_documents", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  stage: text("stage").notNull().$type<Stage>(),
  kind: text("kind").notNull(), // sac_script|contest_letter|gov_text|regulator_text|dossier
  promptVersion: integer("prompt_version").notNull(),
  variant: text("variant"),
  body: jsonb("body").$type<ContestDocument>().notNull(),
  userEdited: boolean("user_edited").notNull().default(false),
  editedBody: jsonb("edited_body").$type<ContestDocument>(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stageValues: check(
    "case_documents_stage_values",
    sql`${t.stage} in ('draft','sac','ombudsman','consumidor_gov','regulator','procon','jec_ready','closed')`,
  ),
  kindValues: check(
    "case_documents_kind_values",
    sql`${t.kind} in ('sac_script','contest_letter','gov_text','regulator_text','dossier')`,
  ),
}));

export const caseProtocols = pgTable("case_protocols", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  stage: text("stage").notNull().$type<Stage>(),
  protocolNumber: text("protocol_number").notNull(),
  channel: text("channel").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
  responseDueAt: timestamp("response_due_at", { withTimezone: true }).notNull(),
  responseReceivedAt: timestamp("response_received_at", { withTimezone: true }),
  responseSummary: text("response_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stageValues: check(
    "case_protocols_stage_values",
    sql`${t.stage} in ('draft','sac','ombudsman','consumidor_gov','regulator','procon','jec_ready','closed')`,
  ),
}));

// The one table without `updated_at`: an event is immutable by definition,
// so it carries only `occurred_at`.
export const events = pgTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  sessionId: text("session_id"),
  caseId: text("case_id"),
  invoiceId: text("invoice_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byCase: index("events_case_time").on(t.caseId, t.occurredAt),
  byTypeTime: index("events_type_time").on(t.type, t.occurredAt),
}));

export const aiCalls = pgTable("ai_calls", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id"),
  caseId: text("case_id"),
  purpose: text("purpose").notNull(), // classify|extract|contest|agent
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: integer("prompt_version"),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  costUsd: real("cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  traceId: text("trace_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  purposeValues: check("ai_calls_purpose_values", sql`${t.purpose} in ('classify','extract','contest','agent')`),
}));

export const prompts = pgTable("prompts", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  modelDefault: text("model_default").notNull(),
  status: text("status").notNull().default("draft"), // draft|active|retired
  metrics: jsonb("metrics").$type<Record<string, number>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugVersion: uniqueIndex("prompts_slug_version").on(t.slug, t.version),
  statusValues: check("prompts_status_values", sql`${t.status} in ('draft','active','retired')`),
}));

export const referenceTariffs = pgTable("reference_tariffs", {
  id: text("id").primaryKey(),
  issuerCnpj: text("issuer_cnpj").notNull(),
  subgroup: text("subgroup").notNull(), // B1
  modality: text("modality").notNull(), // Convencional
  className: text("class_name").notNull(), // Residencial
  subClass: text("sub_class").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  tusdCentsMwh: integer("tusd_cents_mwh").notNull(),
  teCentsMwh: integer("te_cents_mwh").notNull(),
  sourceUrl: text("source_url").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ lookup: index("tariffs_lookup").on(t.issuerCnpj, t.subgroup, t.validFrom) }));

export const referenceFlags = pgTable("reference_flags", {
  id: text("id").primaryKey(),
  competence: date("competence").notNull().unique(),
  flag: text("flag").notNull(), // verde|amarela|vermelha_1|vermelha_2|escassez
  valueCentsPer100Kwh: integer("value_cents_per_100kwh").notNull(),
  sourceUrl: text("source_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  flagValues: check(
    "reference_flags_flag_values",
    sql`${t.flag} in ('verde','amarela','vermelha_1','vermelha_2','escassez')`,
  ),
}));

export const aggregates = pgTable("aggregates", {
  id: text("id").primaryKey(),
  issuerId: text("issuer_id").notNull().references(() => issuers.id),
  normalizedDesc: text("normalized_desc").notNull(),
  period: date("period").notNull(),
  invoicesSeen: integer("invoices_seen").notNull().default(0),
  flagged: integer("flagged").notNull().default(0),
  confirmedByUser: integer("confirmed_by_user").notNull().default(0),
  dismissedByUser: integer("dismissed_by_user").notNull().default(0),
  resolved: integer("resolved").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: uniqueIndex("agg_uniq").on(t.issuerId, t.normalizedDesc, t.period) }));

export const entitlements = pgTable("entitlements", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  plan: text("plan").notNull(),
  source: text("source").notNull(), // stripe|revenuecat|manual
  externalId: text("external_id"),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index("entitlements_user").on(t.userId),
  sourceValues: check("entitlements_source_values", sql`${t.source} in ('stripe','revenuecat','manual')`),
}));

export const seoPages = pgTable("seo_pages", {
  id: text("id").primaryKey(),
  issuerId: text("issuer_id").notNull().references(() => issuers.id),
  chargeSlug: text("charge_slug").notNull(),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("seo_uniq").on(t.issuerId, t.chargeSlug),
  statusValues: check("seo_pages_status_values", sql`${t.status} in ('draft','published')`),
}));

export const ruleMetrics = pgTable("rule_metrics", {
  id: text("id").primaryKey(),
  ruleSlug: text("rule_slug").notNull(),
  ruleVersion: integer("rule_version").notNull(),
  day: date("day").notNull(),
  fired: integer("fired").notNull().default(0),
  dismissed: integer("dismissed").notNull().default(0),
  confirmed: integer("confirmed").notNull().default(0),
  contested: integer("contested").notNull().default(0),
  resolved: integer("resolved").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: uniqueIndex("rule_metrics_uniq").on(t.ruleSlug, t.ruleVersion, t.day) }));

export const agentProposals = pgTable("agent_proposals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // adjust_confidence|pause_rule|promote_variant|new_rule_draft|prompt_edit
  target: text("target").notNull(),
  payload: jsonb("payload").notNull(),
  evidence: jsonb("evidence").$type<string[]>().notNull(),
  status: text("status").notNull().default("pending"), // pending|approved|rejected
  decidedBy: text("decided_by"),
  decisionReason: text("decision_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindValues: check(
    "agent_proposals_kind_values",
    sql`${t.kind} in ('adjust_confidence','pause_rule','promote_variant','new_rule_draft','prompt_edit')`,
  ),
  statusValues: check("agent_proposals_status_values", sql`${t.status} in ('pending','approved','rejected')`),
}));
