CREATE TABLE "ci_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"run_id" bigint NOT NULL,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	"head_sha" text NOT NULL,
	"branch" text NOT NULL,
	"workflow_name" text NOT NULL,
	"html_url" text NOT NULL,
	"pr_number" integer,
	"job_name" text,
	"step_name" text,
	"failure_excerpt" text,
	"signature" text,
	"analysis" jsonb,
	"state" text DEFAULT 'captured' NOT NULL,
	"last_error" text,
	"slack_channel_id" text,
	"slack_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"analysed_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "ci_failures_run_attempt_key" UNIQUE("org_id","run_id","run_attempt")
);
--> statement-breakpoint
ALTER TABLE "ci_failures" ADD CONSTRAINT "ci_failures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_failures" ADD CONSTRAINT "ci_failures_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_failures_org_created_idx" ON "ci_failures" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ci_failures_signature_idx" ON "ci_failures" USING btree ("org_id","signature");