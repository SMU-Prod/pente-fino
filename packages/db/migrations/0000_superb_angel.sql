CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "agent_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"payload" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_proposals_kind_values" CHECK ("agent_proposals"."kind" in ('adjust_confidence','pause_rule','promote_variant','new_rule_draft','prompt_edit','promote_rule')),
	CONSTRAINT "agent_proposals_status_values" CHECK ("agent_proposals"."status" in ('pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "aggregates" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer_id" text NOT NULL,
	"normalized_desc" text NOT NULL,
	"period" date NOT NULL,
	"invoices_seen" integer DEFAULT 0 NOT NULL,
	"flagged" integer DEFAULT 0 NOT NULL,
	"confirmed_by_user" integer DEFAULT 0 NOT NULL,
	"dismissed_by_user" integer DEFAULT 0 NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text,
	"case_id" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" real NOT NULL,
	"latency_ms" integer NOT NULL,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_calls_purpose_values" CHECK ("ai_calls"."purpose" in ('classify','extract','contest','agent'))
);
--> statement-breakpoint
CREATE TABLE "anonymous_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"claimed_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"stage" text NOT NULL,
	"kind" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"variant" text,
	"body" jsonb NOT NULL,
	"user_edited" boolean DEFAULT false NOT NULL,
	"edited_body" jsonb,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_documents_stage_values" CHECK ("case_documents"."stage" in ('draft','sac','ombudsman','consumidor_gov','regulator','procon','jec_ready','closed')),
	CONSTRAINT "case_documents_kind_values" CHECK ("case_documents"."kind" in ('sac_script','contest_letter','gov_text','regulator_text','dossier'))
);
--> statement-breakpoint
CREATE TABLE "case_protocols" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"stage" text NOT NULL,
	"protocol_number" text NOT NULL,
	"channel" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"response_received_at" timestamp with time zone,
	"response_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_protocols_stage_values" CHECK ("case_protocols"."stage" in ('draft','sac','ombudsman','consumidor_gov','regulator','procon','jec_ready','closed'))
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"issuer_id" text NOT NULL,
	"finding_ids" jsonb NOT NULL,
	"stage" text DEFAULT 'draft' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_deadline_at" timestamp with time zone,
	"workflow_run_id" text,
	"protocol_token" text,
	"outcome" text,
	"outcome_confirmed_by" text,
	"recovered_cents" integer,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_stage_values" CHECK ("cases"."stage" in ('draft','sac','ombudsman','consumidor_gov','regulator','procon','jec_ready','closed')),
	CONSTRAINT "cases_outcome_values" CHECK ("cases"."outcome" in ('resolved','partial','denied','abandoned')),
	CONSTRAINT "cases_outcome_confirmed_by_values" CHECK ("cases"."outcome_confirmed_by" in ('diff','user','none'))
);
--> statement-breakpoint
CREATE TABLE "claim_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"session_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_source_values" CHECK ("entitlements"."source" in ('stripe','revenuecat','manual'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"session_id" text,
	"case_id" text,
	"invoice_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"item_id" text,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_cents" integer NOT NULL,
	"doubled_cents" integer,
	"shadow" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_status_values" CHECK ("findings"."status" in ('open','confirmed_by_user','dismissed_by_user','contested','resolved','unresolved'))
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_key" text NOT NULL,
	"section" text,
	"description" text NOT NULL,
	"normalized_desc" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"qty" real,
	"unit_price_cents" integer,
	"period_ref" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"session_id" text,
	"issuer_id" text,
	"content_hash" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"due_date" date,
	"total_cents" integer,
	"source" text NOT NULL,
	"extraction_quality" real,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_key" text,
	"file_expires_at" timestamp with time zone,
	"canonical" jsonb,
	"masked" boolean DEFAULT false NOT NULL,
	"public_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_public_token_unique" UNIQUE("public_token"),
	CONSTRAINT "invoices_source_values" CHECK ("invoices"."source" in ('pdf_text','pdf_vision','photo','csv','email')),
	CONSTRAINT "invoices_status_values" CHECK ("invoices"."status" in ('queued','extracting','validating','analyzed','needs_review','failed'))
);
--> statement-breakpoint
CREATE TABLE "issuers" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"display_name" text NOT NULL,
	"cnpj" text,
	"aliases" jsonb DEFAULT '[]'::jsonb,
	"sections" jsonb DEFAULT '[]'::jsonb,
	"playbook" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issuers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "issuers_category_values" CHECK ("issuers"."category" in ('telecom','card','energy','water')),
	CONSTRAINT "issuers_status_values" CHECK ("issuers"."status" in ('active','unknown','paused'))
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"model_default" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_status_values" CHECK ("prompts"."status" in ('draft','active','retired'))
);
--> statement-breakpoint
CREATE TABLE "reference_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"competence" date NOT NULL,
	"flag" text NOT NULL,
	"value_cents_per_100kwh" integer NOT NULL,
	"source_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_flags_competence_unique" UNIQUE("competence"),
	CONSTRAINT "reference_flags_flag_values" CHECK ("reference_flags"."flag" in ('verde','amarela','vermelha_1','vermelha_2','escassez'))
);
--> statement-breakpoint
CREATE TABLE "reference_tariffs" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer_cnpj" text NOT NULL,
	"subgroup" text NOT NULL,
	"modality" text NOT NULL,
	"class_name" text NOT NULL,
	"sub_class" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"tusd_cents_mwh" integer NOT NULL,
	"te_cents_mwh" integer NOT NULL,
	"source_url" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_slug" text NOT NULL,
	"rule_version" integer NOT NULL,
	"day" date NOT NULL,
	"fired" integer DEFAULT 0 NOT NULL,
	"dismissed" integer DEFAULT 0 NOT NULL,
	"confirmed" integer DEFAULT 0 NOT NULL,
	"contested" integer DEFAULT 0 NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"category" text NOT NULL,
	"issuer_id" text,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"legal_basis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence_base" real NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"shadow_until" timestamp with time zone,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_category_values" CHECK ("rules"."category" in ('telecom','card','energy','water')),
	CONSTRAINT "rules_kind_values" CHECK ("rules"."kind" in ('pattern','delta','threshold','reference','confirm','arithmetic','suppressor')),
	CONSTRAINT "rules_status_values" CHECK ("rules"."status" in ('draft','shadow','active','paused'))
);
--> statement-breakpoint
CREATE TABLE "seo_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer_id" text NOT NULL,
	"charge_slug" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seo_pages_status_values" CHECK ("seo_pages"."status" in ('draft','published'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"email_forward_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_forward_token_unique" UNIQUE("email_forward_token"),
	CONSTRAINT "users_plan_values" CHECK ("users"."plan" in ('free','premium'))
);
--> statement-breakpoint
ALTER TABLE "aggregates" ADD CONSTRAINT "aggregates_issuer_id_issuers_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymous_sessions" ADD CONSTRAINT "anonymous_sessions_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_protocols" ADD CONSTRAINT "case_protocols_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_issuer_id_issuers_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_codes" ADD CONSTRAINT "claim_codes_session_id_anonymous_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."anonymous_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_item_id_invoice_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_session_id_anonymous_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."anonymous_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issuer_id_issuers_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_issuer_id_issuers_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_pages" ADD CONSTRAINT "seo_pages_issuer_id_issuers_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agg_uniq" ON "aggregates" USING btree ("issuer_id","normalized_desc","period");--> statement-breakpoint
CREATE INDEX "cases_next_deadline" ON "cases" USING btree ("next_deadline_at") WHERE "cases"."stage" <> 'closed';--> statement-breakpoint
CREATE INDEX "claim_codes_email_created" ON "claim_codes" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "entitlements_user" ON "entitlements" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_case_time" ON "events" USING btree ("case_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_type_time" ON "events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "items_invoice_desc" ON "invoice_items" USING btree ("invoice_id","normalized_desc");--> statement-breakpoint
CREATE INDEX "items_desc_trgm" ON "invoice_items" USING gin ("normalized_desc" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "items_invoice_key" ON "invoice_items" USING btree ("invoice_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_owner_hash" ON "invoices" USING btree (coalesce("user_id", "session_id"),"content_hash");--> statement-breakpoint
CREATE INDEX "invoices_user_issuer_period" ON "invoices" USING btree ("user_id","issuer_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_slug_version" ON "prompts" USING btree ("slug","version");--> statement-breakpoint
CREATE INDEX "tariffs_lookup" ON "reference_tariffs" USING btree ("issuer_cnpj","subgroup","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_metrics_uniq" ON "rule_metrics" USING btree ("rule_slug","rule_version","day");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_slug_version" ON "rules" USING btree ("slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_uniq" ON "seo_pages" USING btree ("issuer_id","charge_slug");