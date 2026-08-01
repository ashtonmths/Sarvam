CREATE TYPE "public"."drift_kind" AS ENUM('hash_change', 'staleness', 'unresolved_ref');--> statement-breakpoint
CREATE TYPE "public"."finding_state" AS ENUM('open', 'investigating', 'corrected', 'dismissed', 'auto_dismissed');--> statement-breakpoint
CREATE TABLE "drift_findings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"connector_instance_id" bigint NOT NULL,
	"kind" "drift_kind" NOT NULL,
	"scope" text NOT NULL,
	"signature" text NOT NULL,
	"documented_state" jsonb,
	"live_state" jsonb,
	"state" "finding_state" DEFAULT 'open' NOT NULL,
	"dismiss_reason" text,
	"budget_exhausted_at" timestamp with time zone,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "structural_hashes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"connector_instance_id" bigint NOT NULL,
	"scope" text NOT NULL,
	"hash" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "structural_hashes_identity" UNIQUE("org_id","connector_instance_id","scope")
);
--> statement-breakpoint
ALTER TABLE "drift_findings" ADD CONSTRAINT "drift_findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_findings" ADD CONSTRAINT "drift_findings_connector_instance_id_connector_instances_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structural_hashes" ADD CONSTRAINT "structural_hashes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structural_hashes" ADD CONSTRAINT "structural_hashes_connector_instance_id_connector_instances_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drift_findings_org_state_idx" ON "drift_findings" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "drift_findings_signature_idx" ON "drift_findings" USING btree ("org_id","signature");