-- Sentinel: covering indexes, the FTS index, and graph-version invalidation.
-- Hand-written because none of it is expressible in the Drizzle schema.

-- The recursive step is a lookup by (org_id, dst_id) on every hop, so it must
-- be an index-only scan. If EXPLAIN shows a heap fetch here, the INCLUDE list
-- is wrong.
DROP INDEX IF EXISTS "edges_dst_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "edges_src_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edges_dst_covering_idx"
  ON "edges" ("org_id", "dst_id") INCLUDE ("src_id", "confidence", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edges_src_covering_idx"
  ON "edges" ("org_id", "src_id") INCLUDE ("dst_id", "confidence", "id");--> statement-breakpoint

-- Hybrid retrieval's lexical branch. The expression must match the one in
-- retrieve.ts and explain.ts verbatim — a differing to_tsvector call silently
-- loses this index and degrades to a sequential scan.
CREATE INDEX IF NOT EXISTS "rationale_fts_idx"
  ON "rationale" USING gin (to_tsvector('english', "body"));--> statement-breakpoint

-- Graph version: the cache-invalidation signal. Statement-level, not
-- row-level, because crawls upsert in batches and should bump once per
-- statement rather than once per row.
-- One function per operation, because a statement trigger can only reference
-- the transition tables that exist for its own event.
CREATE OR REPLACE FUNCTION sadhak_bump_graph_version_ins() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO graph_versions (org_id, version)
  SELECT DISTINCT org_id, 1 FROM new_rows
  ON CONFLICT (org_id) DO UPDATE SET version = graph_versions.version + 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sadhak_bump_graph_version_del() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO graph_versions (org_id, version)
  SELECT DISTINCT org_id, 1 FROM old_rows
  ON CONFLICT (org_id) DO UPDATE SET version = graph_versions.version + 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS edges_version_ins ON edges;--> statement-breakpoint
CREATE TRIGGER edges_version_ins AFTER INSERT ON edges
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sadhak_bump_graph_version_ins();--> statement-breakpoint

DROP TRIGGER IF EXISTS edges_version_upd ON edges;--> statement-breakpoint
CREATE TRIGGER edges_version_upd AFTER UPDATE ON edges
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sadhak_bump_graph_version_ins();--> statement-breakpoint

DROP TRIGGER IF EXISTS edges_version_del ON edges;--> statement-breakpoint
CREATE TRIGGER edges_version_del AFTER DELETE ON edges
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sadhak_bump_graph_version_del();--> statement-breakpoint

-- Criticality is in the impact formula, so a human override must invalidate
-- exactly like an edge write does. Postgres rejects transition tables on a
-- trigger carrying a column list, so this fires on any node update: a
-- re-crawl bumps the version too, which is honest rather than over-eager —
-- the graph did change.
DROP TRIGGER IF EXISTS nodes_criticality_version ON nodes;--> statement-breakpoint
CREATE TRIGGER nodes_criticality_version AFTER UPDATE ON nodes
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sadhak_bump_graph_version_ins();
