-- The activation funnel, as SQL over our own tables.
--
-- First-party by design. A third-party analytics pixel can tell you the shape
-- of a funnel; it cannot tell you whether a crawl finished, and "signed up" is
-- worth nothing next to "got a verdict on their own systems". Every step below
-- is a fact in our database rather than an event someone's browser agreed to
-- send.
--
--   psql "$DATABASE_URL" -f docs/launch/funnel.sql

\echo '== Activation funnel (all time) =='

WITH orgs AS (
  SELECT id, name, created_at FROM organizations
),
connected AS (
  SELECT DISTINCT org_id FROM connector_instances
),
crawled AS (
  SELECT DISTINCT org_id FROM crawls WHERE state = 'succeeded'
),
gated AS (
  SELECT DISTINCT org_id FROM verdicts
),
explained AS (
  SELECT DISTINCT org_id FROM rationale WHERE state = 'confirmed'
)
SELECT
  '1. signed up'          AS step, count(*) AS orgs FROM orgs
UNION ALL SELECT
  '2. connected a system', count(*) FROM connected
UNION ALL SELECT
  '3. first crawl',        count(*) FROM crawled
UNION ALL SELECT
  '4. first verdict',      count(*) FROM gated
UNION ALL SELECT
  '5. confirmed a why',    count(*) FROM explained
ORDER BY step;

\echo ''
\echo '== Time to first verdict, per org =='
-- The number that matters most. The quickstart promises under thirty minutes;
-- this is whether that promise survives contact with real systems.

SELECT
  o.name,
  o.created_at::date                                        AS signed_up,
  min(v.created_at) - o.created_at                          AS time_to_first_verdict
FROM organizations o
JOIN verdicts v ON v.org_id = o.id
GROUP BY o.id, o.name, o.created_at
ORDER BY time_to_first_verdict;

\echo ''
\echo '== Orgs that stalled, and where =='
-- Read this one before the funnel counts. A step nobody passes is a product
-- problem; a step one org stalled on is a support conversation.

SELECT
  o.name,
  o.created_at::date AS signed_up,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM connector_instances c WHERE c.org_id = o.id)
      THEN 'never connected anything'
    WHEN NOT EXISTS (SELECT 1 FROM crawls c WHERE c.org_id = o.id AND c.state = 'succeeded')
      THEN 'connected, no successful crawl'
    WHEN NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.org_id = o.id)
      THEN 'has a map, never asked the gate'
    WHEN NOT EXISTS (SELECT 1 FROM rationale r WHERE r.org_id = o.id AND r.state = 'confirmed')
      THEN 'gating, but nobody has confirmed a why'
    ELSE 'activated'
  END AS stalled_at
FROM organizations o
ORDER BY o.created_at DESC;
