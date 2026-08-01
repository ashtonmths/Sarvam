ALTER TABLE "n8n_execution_failures" ADD COLUMN "diagnosis_state" text DEFAULT 'captured' NOT NULL;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD COLUMN "diagnosis" jsonb;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD COLUMN "diagnosis_error" text;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD COLUMN "slack_ts" text;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD COLUMN "diagnosed_at" timestamp with time zone;