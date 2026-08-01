import type { EvidenceHop } from "@sadhak/shared/types";
import { sql } from "../db.js";
import { DECAY, MAX_HOPS, PRUNE_BELOW } from "./score.js";

/**
 * The blast radius, in one SQL statement.
 *
 * Direction: the walk goes **dst → src**, from the node being changed toward
 * the things that depend on it. `src` depends on `dst` by the edge invariant
 * Cartographer enforces, so reversing this produces a confidently wrong
 * answer — which is worse than no answer.
 *
 * Per-node dedupe is a semantic decision, not an optimization. The CTE emits
 * one row per *path*; a node reachable five ways would otherwise count five
 * times toward the Σ-impact WARN rule, making any dense graph WARN trivially.
 * `DISTINCT ON (id) … ORDER BY id, impact DESC` keeps each node once, on its
 * strongest path. The diamond golden pins this.
 */

export interface RawBlastRow {
  id: number;
  name: string;
  kind: string;
  hops: number;
  criticality: number;
  pathConfidence: number;
  minEdgeConfidence: number;
  impact: number;
  edgeIds: number[];
}

interface RawRow {
  id: string | number;
  name: string;
  kind: string;
  hops: number;
  criticality: number;
  path_conf: number;
  min_conf: number;
  impact: number;
  edge_ids: Array<string | number> | null;
}

export async function traverse(orgId: number, nodeId: number): Promise<RawBlastRow[]> {
  const rows = (await sql`
    WITH RECURSIVE blast AS (
      SELECT n.id, n.criticality, 1.0::REAL AS path_conf, 1.0::REAL AS min_conf,
             0 AS hops, ARRAY[n.id] AS path, ARRAY[]::BIGINT[] AS edge_ids
      FROM nodes n
      WHERE n.id = ${nodeId} AND n.org_id = ${orgId}
      UNION ALL
      SELECT e.src_id, n.criticality,
             (b.path_conf * e.confidence)::REAL,
             LEAST(b.min_conf, e.confidence)::REAL,
             b.hops + 1, b.path || e.src_id, b.edge_ids || e.id
      FROM blast b
      JOIN edges e ON e.dst_id = b.id AND e.org_id = ${orgId}
      JOIN nodes n ON n.id = e.src_id AND n.org_id = ${orgId}
      WHERE b.hops < ${MAX_HOPS}
        AND NOT (e.src_id = ANY(b.path))
        AND b.path_conf * e.confidence > ${PRUNE_BELOW}
    )
    SELECT DISTINCT ON (b.id)
           b.id, n.name, n.kind::text AS kind, b.hops, b.criticality,
           b.path_conf, b.min_conf, b.edge_ids,
           (b.criticality * b.path_conf * POWER(${DECAY}, GREATEST(b.hops - 1, 0)))::REAL AS impact
    FROM blast b
    JOIN nodes n ON n.id = b.id
    WHERE b.hops > 0
    ORDER BY b.id, impact DESC
  `) as unknown as RawRow[];

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    hops: Number(row.hops),
    criticality: Number(row.criticality),
    pathConfidence: Number(row.path_conf),
    minEdgeConfidence: Number(row.min_conf),
    impact: Number(row.impact),
    edgeIds: (row.edge_ids ?? []).map(Number),
  }));
}

/**
 * Hydrates the winning path's edges. A second indexed query rather than more
 * CTE columns — two round-trips, both cheap, and the recursive step stays lean.
 */
export async function hydrateHops(
  orgId: number,
  edgeIds: number[],
): Promise<Map<number, EvidenceHop>> {
  if (edgeIds.length === 0) return new Map();

  const rows = (await sql`
    SELECT id, src_id, dst_id, kind::text AS kind, confidence, provenance::text AS provenance
    FROM edges
    WHERE id = ANY(${edgeIds}) AND org_id = ${orgId}
  `) as unknown as Array<{
    id: string | number;
    src_id: string | number;
    dst_id: string | number;
    kind: string;
    confidence: number;
    provenance: string;
  }>;

  return new Map(
    rows.map((row) => [
      Number(row.id),
      {
        edgeId: Number(row.id),
        srcId: Number(row.src_id),
        dstId: Number(row.dst_id),
        kind: row.kind,
        confidence: Number(row.confidence),
        provenance: row.provenance,
      },
    ]),
  );
}

/**
 * Distinct *confirmed* authors per edge. Drafts never feed a verdict input,
 * the same rule the coverage metric follows — an LLM draft must not be able to
 * manufacture a key-person warning.
 */
export async function busFactorByEdge(
  orgId: number,
  edgeIds: number[],
): Promise<Map<number, number>> {
  if (edgeIds.length === 0) return new Map();

  const rows = (await sql`
    SELECT rl.edge_id, COUNT(DISTINCT r.author)::int AS authors
    FROM rationale_links rl
    JOIN rationale r ON r.id = rl.rationale_id
    WHERE rl.edge_id = ANY(${edgeIds})
      AND r.org_id = ${orgId}
      AND r.state = 'confirmed'
      AND r.author IS NOT NULL
    GROUP BY rl.edge_id
  `) as unknown as Array<{ edge_id: string | number; authors: number }>;

  return new Map(rows.map((row) => [Number(row.edge_id), Number(row.authors)]));
}
