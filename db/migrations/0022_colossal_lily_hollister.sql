CREATE TABLE "oauth_access_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"secret_hash" text,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registration_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_to_id" bigint,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_user_idx" ON "oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_client_idx" ON "oauth_authorization_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_user_idx" ON "oauth_refresh_tokens" USING btree ("user_id");