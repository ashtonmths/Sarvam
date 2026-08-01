-- Expression indexes for document retrieval. Hand-written, and deliberately
-- not in the Drizzle schema: neither of these is expressible there, which is
-- the same reason 0003 exists. Hand-written migrations carry no snapshot, so
-- `drizzle-kit generate` continues from 0011 and leaves these alone.

-- The lexical half of hybrid retrieval. This expression must match the
-- to_tsvector call in apps/api/src/documents/retrieve.ts verbatim — a differing
-- call silently loses the index and degrades to a sequential scan over every
-- chunk the organisation has.
CREATE INDEX IF NOT EXISTS "document_chunks_fts_idx"
  ON "document_chunks" USING gin (to_tsvector('english', "body"));--> statement-breakpoint

-- The embed worker claims rows by this predicate on every batch, and in steady
-- state it matches nothing. A partial index keeps that scan proportional to the
-- backlog rather than to the whole corpus.
CREATE INDEX IF NOT EXISTS "document_chunks_pending_embed_idx"
  ON "document_chunks" ("id") WHERE "embedding" IS NULL;
