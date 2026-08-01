-- UNLOGGED is the point of this table and is added by hand: drizzle-kit has no
-- way to express it, and it does not appear in the snapshot, so `db:generate`
-- stays clean afterwards rather than trying to recreate the table.
--
-- Rate counters are not worth WAL churn. A crash truncates the table, which
-- costs one window of over-permissive limiting and never costs correctness.
-- Restoring a replica from a backup must not resurrect stale counters either.
CREATE UNLOGGED TABLE "rate_counters" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_counters_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
