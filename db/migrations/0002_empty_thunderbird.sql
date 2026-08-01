CREATE TYPE "public"."gate_mode" AS ENUM('hard_gate', 'proxy_gate', 'mcp', 'forward');--> statement-breakpoint
CREATE TYPE "public"."historian_run_state" AS ENUM('queued', 'running', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."incident_state" AS ENUM('detected', 'alerted', 'acknowledged', 'reverting', 'reverted', 'revert_failed');--> statement-breakpoint
ALTER TYPE "public"."rationale_state" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "gate_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"verdict_id" uuid NOT NULL,
	"mode" "gate_mode" NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"actor" text,
	"api_key_id" bigint,
	"idempotency_key" text,
	"request_hash" text,
	"executed_at" timestamp with time zone,
	"execution_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_decisions_idem" UNIQUE("api_key_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"org_id" bigint,
	"account_login" text,
	"repository_selection" text,
	"suspended_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "graph_versions" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "historian_run_edges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"edge_id" bigint NOT NULL,
	"loop_run_id" text,
	"outcome" text,
	CONSTRAINT "historian_run_edges_identity" UNIQUE("run_id","edge_id")
);
--> statement-breakpoint
CREATE TABLE "historian_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"subject_node_id" bigint,
	"state" "historian_run_state" DEFAULT 'queued' NOT NULL,
	"edges_total" integer DEFAULT 0 NOT NULL,
	"edges_proposed" integer DEFAULT 0 NOT NULL,
	"edges_gave_up" integer DEFAULT 0 NOT NULL,
	"edges_skipped_quota" integer DEFAULT 0 NOT NULL,
	"request_budget" integer DEFAULT 0 NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"started_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"org_id" bigint,
	"agent" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "llm_requests_identity" UNIQUE("day","org_id","agent")
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"month" date NOT NULL,
	"agent" text NOT NULL,
	"tier" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "llm_usage_identity" UNIQUE("org_id","month","agent","tier")
);
--> statement-breakpoint
CREATE TABLE "mining_scopes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"connector" text NOT NULL,
	"scope_value" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mining_scopes_identity" UNIQUE("org_id","connector","scope_value")
);
--> statement-breakpoint
CREATE TABLE "reflex_incidents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"dedupe_key" text NOT NULL,
	"connector" text NOT NULL,
	"target" text NOT NULL,
	"operation" text NOT NULL,
	"external_id" text NOT NULL,
	"node_id" bigint,
	"actor" jsonb,
	"verdict" text,
	"verdict_id" uuid,
	"blast" jsonb,
	"evidence" jsonb,
	"detect_path" text DEFAULT 'push' NOT NULL,
	"slack_channel" text,
	"slack_ts" text,
	"change_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verdict_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"revert_requested_at" timestamp with time zone,
	"revert_requested_by" text,
	"reverted_at" timestamp with time zone,
	"revert_error" text,
	"state" "incident_state" DEFAULT 'detected' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflex_incidents_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "reflex_settings" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"slack_channel_id" text,
	"alert_threshold" text DEFAULT 'WARN' NOT NULL,
	"dm_actor" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "structure_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"connector" text NOT NULL,
	"external_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"structure" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "structure_snapshots_identity" UNIQUE("org_id","connector","external_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" bigint NOT NULL,
	"change" jsonb NOT NULL,
	"verdict" text NOT NULL,
	"impacted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"graph_version" bigint DEFAULT 0 NOT NULL,
	"computed_in_ms" integer DEFAULT 0 NOT NULL,
	"explanation" text,
	"explanation_state" text DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_versions" ADD CONSTRAINT "graph_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historian_run_edges" ADD CONSTRAINT "historian_run_edges_run_id_historian_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historian_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historian_run_edges" ADD CONSTRAINT "historian_run_edges_edge_id_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historian_runs" ADD CONSTRAINT "historian_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historian_runs" ADD CONSTRAINT "historian_runs_subject_node_id_nodes_id_fk" FOREIGN KEY ("subject_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mining_scopes" ADD CONSTRAINT "mining_scopes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflex_incidents" ADD CONSTRAINT "reflex_incidents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflex_incidents" ADD CONSTRAINT "reflex_incidents_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflex_incidents" ADD CONSTRAINT "reflex_incidents_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflex_settings" ADD CONSTRAINT "reflex_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structure_snapshots" ADD CONSTRAINT "structure_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gate_decisions_org_time_idx" ON "gate_decisions" USING btree ("org_id","created_at","id");--> statement-breakpoint
CREATE INDEX "github_installations_org_idx" ON "github_installations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "historian_run_edges_loop_idx" ON "historian_run_edges" USING btree ("loop_run_id");--> statement-breakpoint
CREATE INDEX "historian_runs_org_idx" ON "historian_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "reflex_incidents_org_state_idx" ON "reflex_incidents" USING btree ("org_id","state","created_at");--> statement-breakpoint
CREATE INDEX "structure_snapshots_lookup_idx" ON "structure_snapshots" USING btree ("org_id","external_id","captured_at");--> statement-breakpoint
CREATE INDEX "verdicts_org_time_idx" ON "verdicts" USING btree ("org_id","created_at");