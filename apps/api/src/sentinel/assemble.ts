import type { BlastRow, EvidenceHop } from "@sadhak/shared/types";
import type { RawBlastRow } from "./traverse.js";

/**
 * Converts raw CTE output into the scored contract `score.ts` consumes.
 * Computes nothing itself — pure, so it is unit-testable without a database,
 * which is what keeps `score.ts` I/O-free.
 */
export function toBlastRows(
  raw: RawBlastRow[],
  hopsById: Map<number, EvidenceHop>,
  authorsByEdge: Map<number, number>,
): BlastRow[] {
  return raw.map((row) => {
    const path = row.edgeIds
      .map((edgeId) => hopsById.get(edgeId))
      .filter((hop): hop is EvidenceHop => hop !== undefined);

    // Distinct confirmed authors across this node's winning path. Zero means
    // *unexplained*, which is deliberately not bus-factor-1: `score.ts` warns
    // on exactly 1, so an edge nobody documented must not masquerade as a
    // key-person risk.
    const authors = new Set<number>();
    let sawAny = false;
    for (const edgeId of row.edgeIds) {
      const count = authorsByEdge.get(edgeId);
      if (count !== undefined && count > 0) {
        sawAny = true;
        authors.add(count);
      }
    }
    const busFactor = sawAny ? Math.max(...authors) : 0;

    return {
      nodeId: row.id,
      name: row.name,
      kind: row.kind,
      hops: row.hops,
      criticality: row.criticality,
      pathConfidence: row.pathConfidence,
      minEdgeConfidence: row.minEdgeConfidence,
      impact: row.impact,
      busFactor,
      path,
    };
  });
}
