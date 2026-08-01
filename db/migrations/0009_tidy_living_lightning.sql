CREATE TABLE "metric_rollups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"value" numeric NOT NULL,
	"meta" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_rollups_identity" UNIQUE("org_id","day","metric")
);
--> statement-breakpoint
ALTER TABLE "metric_rollups" ADD CONSTRAINT "metric_rollups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;