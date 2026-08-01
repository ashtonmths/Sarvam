-- Uploaded documents: transcripts, notes, anything written down outside a
-- system Sadhak can crawl. Hand-written because the FTS index is an expression
-- index Drizzle cannot express.

CREATE TABLE IF NOT EXISTS "documents" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "org_id" bigint NOT NULL,
  "title" text NOT NULL,
  "original_name" text,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "byte_size" integer NOT NULL,
  "occurred_at" timestamp with time zone,
  "source_url" text,
  "uploaded_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "documents_org_hash_key" UNIQUE("org_id","content_hash")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "document_chunks" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "org_id" bigint NOT NULL,
  "document_id" bigint NOT NULL,
  "ordinal" integer NOT NULL,
  "body" text NOT NULL,
  "speaker" text,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "token_estimate" integer NOT NULL,
  "embedding" vector(384),
  CONSTRAINT "document_chunks_doc_ordinal_key" UNIQUE("document_id","ordinal")
);--> statement-breakpoint

-- Both cascade from the org, so an org delete leaves nothing behind. Chunks
-- cascade from the document as well: a chunk without its document has no
-- resolvable citation and is unreachable by every query here.
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documents_org_idx"
  ON "documents" ("org_id","created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "document_chunks_org_idx"
  ON "document_chunks" ("org_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "document_chunks_embedding_idx"
  ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

-- The lexical half of hybrid retrieval. The expression must match the one in
-- documents/retrieve.ts verbatim — a differing to_tsvector call silently loses
-- this index and degrades to a sequential scan over every chunk in the org.
CREATE INDEX IF NOT EXISTS "document_chunks_fts_idx"
  ON "document_chunks" USING gin (to_tsvector('english', "body"));--> statement-breakpoint

-- The embed worker claims rows by this predicate on every batch, and it is
-- empty in steady state, so a partial index keeps that scan proportional to
-- the backlog rather than to the corpus.
CREATE INDEX IF NOT EXISTS "document_chunks_pending_embed_idx"
  ON "document_chunks" ("id") WHERE "embedding" IS NULL;
