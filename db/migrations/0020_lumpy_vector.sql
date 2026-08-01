CREATE TYPE "public"."n8n_account_state" AS ENUM('pending', 'invited', 'active', 'failed');--> statement-breakpoint
CREATE TABLE "n8n_accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"n8n_user_id" text,
	"email" text NOT NULL,
	"invite_accept_url" text,
	"state" "n8n_account_state" DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"instance_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	CONSTRAINT "n8n_accounts_user_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "n8n_execution_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"instance_id" bigint NOT NULL,
	"execution_id" bigint NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_name" text,
	"node_id" bigint,
	"mode" text,
	"failed_node" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"detect_path" text DEFAULT 'poll' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "n8n_execution_failures_instance_execution" UNIQUE("instance_id","execution_id")
);
--> statement-breakpoint
ALTER TABLE "n8n_accounts" ADD CONSTRAINT "n8n_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_accounts" ADD CONSTRAINT "n8n_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_accounts" ADD CONSTRAINT "n8n_accounts_instance_id_connector_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD CONSTRAINT "n8n_execution_failures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD CONSTRAINT "n8n_execution_failures_instance_id_connector_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_execution_failures" ADD CONSTRAINT "n8n_execution_failures_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "n8n_execution_failures_org_detected_idx" ON "n8n_execution_failures" USING btree ("org_id","detected_at");--> statement-breakpoint
CREATE INDEX "n8n_execution_failures_workflow_idx" ON "n8n_execution_failures" USING btree ("org_id","workflow_id","detected_at");