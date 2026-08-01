-- The dedupe key the queue already believed it had.
--
-- schema.ts calls it "unique among queued/running rows", but nothing enforced
-- that: `enqueue` does SELECT-then-INSERT, so two API replicas booting together,
-- or a manual trigger racing a self-reschedule, both find nothing and both
-- insert. The worker then claims each with SKIP LOCKED and runs the same crawl
-- twice — and two concurrent reconciles of one instance tombstone each other's
-- writes, because the stale sweep keys on a per-crawl timestamp.
--
-- Constrained to `queued` alone, deliberately, even though the comment in the
-- schema says queued-or-running. Every recurring handler here re-enqueues
-- itself from inside its own run — reviewer.tick, connector.crawl, the embed
-- loop, github.backfill — so the successor is queued while the predecessor is
-- still running. Including 'running' would make that pattern violate the index
-- and break every self-rescheduling job in the codebase. One queued row per key
-- is the property the queue actually needs.
--
-- Hand-written: a partial unique index is not expressible in the Drizzle schema.

-- Existing duplicates would fail the index build, so they are resolved first:
-- keep the oldest queued row per key and delete the rest, which is exactly the
-- state the constraint would have produced had it always been there.
--
-- Deleted rather than moved to 'dead_letter', which is what this did first and
-- which fails from a clean database. `dead_letter` is added to the enum by
-- ALTER TYPE in 0001, drizzle runs every migration inside one transaction, and
-- Postgres refuses an enum value in the same transaction that added it
-- (55P04). It only ever showed up on a from-zero run, so it passed locally on
-- an existing database and broke CI's fresh one.
--
-- Deleting is also the more honest outcome: a duplicate queued job is not a
-- job that failed, it is a job that should never have been written.
DELETE FROM "jobs" j
 WHERE j."dedupe_key" IS NOT NULL
   AND j."state" = 'queued'
   AND EXISTS (
     SELECT 1 FROM "jobs" k
      WHERE k."dedupe_key" = j."dedupe_key"
        AND k."state" = 'queued'
        AND (k."created_at" < j."created_at"
             OR (k."created_at" = j."created_at" AND k."id" < j."id"))
   );--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_queued_idx"
  ON "jobs" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "state" = 'queued';
