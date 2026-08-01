CREATE TYPE "public"."email_category" AS ENUM('auth', 'lifecycle', 'digest');--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint,
	"org_id" bigint,
	"category" "email_category" NOT NULL,
	"template" text NOT NULL,
	"to" text NOT NULL,
	"provider_message_id" text,
	"skipped_reason" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_preferences" (
	"user_id" bigint NOT NULL,
	"category" "email_category" NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_preferences_user_id_category_pk" PRIMARY KEY("user_id","category")
);
--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_preferences" ADD CONSTRAINT "email_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_log_org_template_idx" ON "email_log" USING btree ("org_id","template","sent_at");