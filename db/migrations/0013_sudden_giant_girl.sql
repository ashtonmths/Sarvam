CREATE TYPE "public"."change_kind" AS ENUM('commit', 'pull_request');--> statement-breakpoint
CREATE TYPE "public"."checkpoint_kind" AS ENUM('manual', 'gate_approved', 'crawl_healthy', 'incident_recovered', 'release');--> statement-breakpoint
CREATE TABLE "change_paths" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"change_id" bigint NOT NULL,
	"path" text NOT NULL,
	"status" text DEFAULT 'modified' NOT NULL,
	CONSTRAINT "change_paths_change_path_key" UNIQUE("change_id","path")
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"kind" "change_kind" NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"author_login" text,
	"author_email" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changes_repo_kind_external_key" UNIQUE("repo_id","kind","external_id")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"kind" "checkpoint_kind" NOT NULL,
	"repo_id" bigint,
	"node_id" bigint,
	"environment" text,
	"label" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_url" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_cursors" (
	"repo_id" bigint NOT NULL,
	"kind" "change_kind" NOT NULL,
	"backfilled_to" timestamp with time zone,
	"caught_up_to" timestamp with time zone,
	"complete" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_cursors_repo_id_kind_pk" PRIMARY KEY("repo_id","kind")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"installation_id" bigint,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_org_full_name_key" UNIQUE("org_id","owner","name")
);
--> statement-breakpoint
ALTER TABLE "change_paths" ADD CONSTRAINT "change_paths_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_cursors" ADD CONSTRAINT "repo_cursors_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_paths_path_idx" ON "change_paths" USING btree ("path");--> statement-breakpoint
CREATE INDEX "changes_repo_time_idx" ON "changes" USING btree ("repo_id","occurred_at");--> statement-breakpoint
CREATE INDEX "changes_org_time_idx" ON "changes" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "checkpoints_org_time_idx" ON "checkpoints" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "checkpoints_repo_time_idx" ON "checkpoints" USING btree ("repo_id","occurred_at");