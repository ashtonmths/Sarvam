-- Which embedding model produced the vectors that are in the database.
--
-- Constrained to a single row by hand, because Drizzle cannot express a CHECK
-- and "one row" is the property the whole guard rests on. A second row would
-- make "has the model changed" ambiguous exactly when it matters.
CREATE TABLE "embedding_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "embedding_state" ADD CONSTRAINT "embedding_state_singleton" CHECK ("id" = 1);
