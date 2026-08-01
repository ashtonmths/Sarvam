-- Deleting an organization was impossible once it had any graph.
--
-- Removing the org cascades to nodes and edges, whose delete triggers then
-- INSERT a graph_versions row for that same org id, inside the same statement
-- that is removing it. The insert fails the foreign key and the whole DELETE
-- rolls back, so `DELETE FROM organizations` could only ever succeed for an org
-- that had never been crawled.
--
-- Bumping a cache-invalidation version for an org that no longer exists is
-- meaningless in any case, so the delete trigger now skips orgs on their way
-- out. The insert path is untouched: a row cannot be inserted for a nonexistent
-- org in the first place.
CREATE OR REPLACE FUNCTION sadhak_bump_graph_version_del() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO graph_versions (org_id, version)
  SELECT DISTINCT old_rows.org_id, 1
  FROM old_rows
  WHERE EXISTS (
    SELECT 1 FROM organizations WHERE organizations.id = old_rows.org_id
  )
  ON CONFLICT (org_id) DO UPDATE SET version = graph_versions.version + 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
