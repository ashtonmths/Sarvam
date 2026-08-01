CREATE TYPE "public"."edge_kind" AS ENUM('READS_FROM', 'WRITES_TO', 'TRIGGERS', 'AUTHENTICATES_WITH', 'DERIVES_FROM', 'OWNED_BY');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."node_kind" AS ENUM('workflow', 'step', 'table', 'field', 'endpoint', 'credential', 'service', 'report', 'person');--> statement-breakpoint
CREATE TYPE "public"."provenance_kind" AS ENUM('static_parse', 'runtime_observed', 'llm_inferred');--> statement-breakpoint
CREATE TYPE "public"."rationale_state" AS ENUM('drafted', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('slack', 'pr', 'commit', 'doc', 'human_capture');--> statement-breakpoint
CREATE TABLE "agent_traces" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"agent" text NOT NULL,
	"step" bigint NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"src_id" bigint NOT NULL,
	"dst_id" bigint NOT NULL,
	"kind" "edge_kind" NOT NULL,
	"confidence" real NOT NULL,
	"provenance" "provenance_kind" NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edges_src_dst_kind" UNIQUE("src_id","dst_id","kind")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "node_kind" NOT NULL,
	"name" text NOT NULL,
	"external_id" text NOT NULL,
	"connector" text NOT NULL,
	"criticality" real DEFAULT 0.4 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_connector_external_id" UNIQUE("connector","external_id")
);
--> statement-breakpoint
CREATE TABLE "rationale" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"embedding" vector(384),
	"source_kind" "source_kind" NOT NULL,
	"source_url" text NOT NULL,
	"author" text,
	"authored_at" timestamp with time zone,
	"state" "rationale_state" DEFAULT 'drafted' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rationale_links" (
	"rationale_id" bigint NOT NULL,
	"edge_id" bigint NOT NULL,
	CONSTRAINT "rationale_links_rationale_id_edge_id_pk" PRIMARY KEY("rationale_id","edge_id")
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_src_id_nodes_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_dst_id_nodes_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rationale_links" ADD CONSTRAINT "rationale_links_rationale_id_rationale_id_fk" FOREIGN KEY ("rationale_id") REFERENCES "public"."rationale"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rationale_links" ADD CONSTRAINT "rationale_links_edge_id_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_traces_run_idx" ON "agent_traces" USING btree ("run_id","step");--> statement-breakpoint
CREATE INDEX "edges_src_idx" ON "edges" USING btree ("src_id");--> statement-breakpoint
CREATE INDEX "edges_dst_idx" ON "edges" USING btree ("dst_id");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("state","run_after");--> statement-breakpoint
CREATE INDEX "rationale_embedding_idx" ON "rationale" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "rationale_state_idx" ON "rationale" USING btree ("state");