CREATE TYPE "public"."connector_status" AS ENUM('pending_auth', 'active', 'degraded', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."crawl_state" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."credential_scope" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TYPE "public"."entity_state" AS ENUM('active', 'stale');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
ALTER TYPE "public"."job_state" ADD VALUE 'dead_letter';--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" bigint,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_kind" text,
	"target_id" text,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_credentials" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"instance_id" bigint NOT NULL,
	"scope" "credential_scope" NOT NULL,
	"kind" text NOT NULL,
	"key_id" text NOT NULL,
	"sealed" text NOT NULL,
	"fingerprint" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "connector_credentials_instance_scope_kind" UNIQUE("instance_id","scope","kind")
);
--> statement-breakpoint
CREATE TABLE "connector_instances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"connector" text NOT NULL,
	"display_name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "connector_status" DEFAULT 'pending_auth' NOT NULL,
	"status_detail" text,
	"crawl_frequency_minutes" integer DEFAULT 30 NOT NULL,
	"last_crawl_at" timestamp with time zone,
	"last_crawl_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"breaker_open_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_instances_org_slug_name" UNIQUE("org_id","connector","display_name")
);
--> statement-breakpoint
CREATE TABLE "crawls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"connector_instance_id" bigint NOT NULL,
	"kind" text DEFAULT 'full' NOT NULL,
	"state" "crawl_state" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "criticality_overrides" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"node_id" bigint NOT NULL,
	"old_value" real NOT NULL,
	"new_value" real NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_org_user" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" bigint NOT NULL,
	"org_id" bigint,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "unresolved_refs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"crawl_id" bigint,
	"raw" jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "nodes" DROP CONSTRAINT "nodes_connector_external_id";--> statement-breakpoint
ALTER TABLE "edges" DROP CONSTRAINT "edges_src_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "edges" DROP CONSTRAINT "edges_dst_id_nodes_id_fk";
--> statement-breakpoint
DROP INDEX "rationale_state_idx";--> statement-breakpoint
DROP INDEX "jobs_claim_idx";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "attempts" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "org_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "org_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "state" "entity_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "stale_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "org_id" bigint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "org_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "connector_instance_id" bigint;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "criticality_source" text DEFAULT 'heuristic' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "state" "entity_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "stale_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rationale" ADD COLUMN "org_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_instance_id_connector_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_instances" ADD CONSTRAINT "connector_instances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_connector_instance_id_connector_instances_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criticality_overrides" ADD CONSTRAINT "criticality_overrides_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criticality_overrides" ADD CONSTRAINT "criticality_overrides_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unresolved_refs" ADD CONSTRAINT "unresolved_refs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unresolved_refs" ADD CONSTRAINT "unresolved_refs_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_org_time_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "crawls_org_started_idx" ON "crawls" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "criticality_overrides_node_idx" ON "criticality_overrides" USING btree ("node_id","created_at");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "unresolved_refs_org_idx" ON "unresolved_refs" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_id_org" UNIQUE("id","org_id");--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_src_org_fk" FOREIGN KEY ("src_id","org_id") REFERENCES "public"."nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_dst_org_fk" FOREIGN KEY ("dst_id","org_id") REFERENCES "public"."nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_connector_instance_id_connector_instances_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rationale" ADD CONSTRAINT "rationale_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_traces_org_time_idx" ON "agent_traces" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "nodes_org_state_idx" ON "nodes" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "rationale_org_state_idx" ON "rationale" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("state","run_after","priority");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_org_connector_external_id" UNIQUE("org_id","connector","external_id");--> statement-breakpoint