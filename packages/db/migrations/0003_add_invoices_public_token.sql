ALTER TABLE "invoices" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_public_token_unique" UNIQUE("public_token");