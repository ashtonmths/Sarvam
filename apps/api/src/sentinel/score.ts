import type { BlastRow, Evidence, Verdict } from "@sadhak/shared/types";

/**
 * The impact model. Pure functions, no I/O, so every threshold is unit
 * testable without a database.
 *
 *   impact(n) = criticality(n) * PRODUCT(confidence(e)) * DECAY^(hops-1)
 *
 * Transitive closure reaches almost everything within six hops, so an unscored
 * blast radius is noise. Decay is what makes distant nodes visible on the map
 * without raising an alarm.
 */

export const DECAY = 0.6;

/** Below this, an edge is too speculative to justify blocking someone's work. */
export const BLOCKING_CONFIDENCE = 0.7;

/** A single node this critical, reached over trusted edges, blocks. */
export const BLOCK_IMPACT = 0.8;

/** Aggregate impact across the whole radius that warrants a warning. */
export const WARN_TOTAL_IMPACT = 0.3;

/**
 * Transitive closure reaches almost everything within six hops. These two are
 * bound as SQL parameters by `traverse.ts`, so the TypeScript impact model and
 * the recursive CTE cannot drift.
 */
export const MAX_HOPS = 6;

/** Paths whose compounded confidence falls below this are noise. */
export const PRUNE_BELOW = 0.05;

export function decayedImpact(
  criticality: number,
  pathConfidence: number,
  hops: number,
): number {
  if (hops < 1) return criticality;
  return criticality * pathConfidence * DECAY ** (hops - 1);
}

/**
 * The verdict. A pure function of the scored blast radius, which is what makes
 * it reproducible, auditable, and fast enough to render before any model has
 * been called.
 *
 * An `llm_inferred` edge carries confidence 0.5 and therefore can never on its
 * own produce a BLOCK. Blocking someone's work on a model's hunch is how you
 * lose the account in week one.
 */
export function verdict(rows: BlastRow[]): { verdict: Verdict; evidence: Evidence[] } {
  const evidence: Evidence[] = [];

  const blocking = rows.filter(
    (r) => r.minEdgeConfidence >= BLOCKING_CONFIDENCE && r.impact >= BLOCK_IMPACT,
  );
  if (blocking.length > 0) {
    for (const r of blocking) {
      evidence.push({
        rule: `impact ${r.impact.toFixed(2)} >= ${BLOCK_IMPACT} over trusted edges`,
        nodeId: r.nodeId,
        name: r.name,
        impact: r.impact,
      });
    }
    return { verdict: "BLOCK", evidence };
  }

  const total = rows.reduce((sum, r) => sum + r.impact, 0);
  const soleOwner = rows.filter((r) => r.busFactor === 1);

  if (total >= WARN_TOTAL_IMPACT) {
    evidence.push({
      rule: `total impact ${total.toFixed(2)} >= ${WARN_TOTAL_IMPACT}`,
      nodeId: -1,
      name: `${rows.length} downstream nodes`,
      impact: total,
    });
  }
  for (const r of soleOwner) {
    evidence.push({
      rule: "only one person can explain this dependency",
      nodeId: r.nodeId,
      name: r.name,
      impact: r.impact,
    });
  }

  if (evidence.length > 0) return { verdict: "WARN", evidence };
  return { verdict: "APPROVE", evidence };
}
