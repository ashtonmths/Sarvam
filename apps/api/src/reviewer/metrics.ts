import type { DetectPath, Metrics, Percentiles } from "@sadhak/shared/types";
import { sql } from "../db.js";

/**
 * The metrics engine. Every number is an event count or a timestamp delta from
 * a table that already exists for another reason.
 *
 * Three rules the queries enforce, each of which someone will eventually be
 * tempted to break because it would make a number look better:
 *
 * 1. **Dry runs never count.** A simulation is a question, not an enforcement.
 *    `gate_decisions.dry_run` exists for exactly this exclusion.
 * 2. **Drafted rationale never counts toward coverage.** A model's guess is
 *    not knowledge until a human confirms it, so coverage is always two
 *    numbers and they are never summed.
 * 3. **Push and poll MTTD are never blended.** They are different mechanisms
 *    with an order of magnitude between them; one average describes neither.
 *
 * | Metric | The fact | Source |
 * |---|---|---|
 * | `revertsExecuted` | reverts that ran and were confirmed | `reflex_incidents.reverted_at` |
 * | `mttdMs` | `detected_at − change_at`, per path | `reflex_incidents` |
 * | `mttrMs` | `reverted_at − alerted_at` | `reflex_incidents` |
 * | `highImpactReviewed` | non-dry-run WARN/BLOCK decisions | `gate_decisions` |
 * | `coverageConfirmed` | active edges with confirmed rationale | `rationale_links` |
 * | `correctionsCaptured` | resolved drift findings + criticality overrides | `drift_findings` |
 */

interface DeltaRow {
  ms: string;
  detect_path: string;
}

/**
 * Median and p95 over a set of deltas, computed in JavaScript rather than SQL
 * so `samples` travels with them. A p95 over three observations is not a p95,
 * and a caller that cannot see the count will quote it as though it were.
 */
function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[index] ?? 0;
  };
  return { median: at(0.5), p95: at(0.95), samples: sorted.length };
}

export async function computeMetrics(orgId: number): Promise<Metrics> {
  /**
   * Detection latency. `change_at` comes from the vendor's payload, so it is
   * their clock against ours: a row where the change appears to happen *after*
   * we detected it is clock skew, not a negative latency. Those are counted
   * and excluded rather than clamped to zero, which would quietly improve the
   * median.
   */
  const detectRows = await sql<DeltaRow[]>`
    SELECT EXTRACT(EPOCH FROM (detected_at - change_at)) * 1000 AS ms,
           detect_path
    FROM reflex_incidents
    WHERE org_id = ${orgId}
      AND change_at IS NOT NULL
      AND detected_at >= change_at
  `;

  const [skew] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM reflex_incidents
    WHERE org_id = ${orgId}
      AND change_at IS NOT NULL
      AND detected_at < change_at
  `;

  const byPath: Record<DetectPath, number[]> = { push: [], poll: [] };
  for (const row of detectRows) {
    const path: DetectPath = row.detect_path === "poll" ? "poll" : "push";
    byPath[path].push(Number(row.ms));
  }

  const repairRows = await sql<{ ms: string }[]>`
    SELECT EXTRACT(EPOCH FROM (reverted_at - alerted_at)) * 1000 AS ms
    FROM reflex_incidents
    WHERE org_id = ${orgId}
      AND reverted_at IS NOT NULL
      AND alerted_at IS NOT NULL
      AND reverted_at >= alerted_at
  `;

  const [reverts] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM reflex_incidents
    WHERE org_id = ${orgId} AND reverted_at IS NOT NULL
  `;

  /**
   * dry_run excluded: a simulation is a question, not an enforcement. The
   * verdict text lives on `verdicts`, not on the decision row — a decision
   * records that a gate was consulted, the verdict records what it said.
   */
  const [highImpact] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM gate_decisions gd
    JOIN verdicts v ON v.id = gd.verdict_id
    WHERE gd.org_id = ${orgId}
      AND gd.dry_run = false
      AND v.verdict IN ('WARN', 'BLOCK')
  `;

  const [edges] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM edges
    WHERE org_id = ${orgId} AND state = 'active'
  `;

  // Two numbers, never one. `confirmed` is knowledge; `drafted` is a proposal.
  const [confirmed] = await sql<{ n: number }[]>`
    SELECT count(DISTINCT rl.edge_id)::int AS n
    FROM rationale_links rl
    JOIN rationale r ON r.id = rl.rationale_id
    JOIN edges e ON e.id = rl.edge_id
    WHERE r.org_id = ${orgId} AND r.state = 'confirmed' AND e.state = 'active'
  `;

  const [pending] = await sql<{ n: number }[]>`
    SELECT count(DISTINCT rl.edge_id)::int AS n
    FROM rationale_links rl
    JOIN rationale r ON r.id = rl.rationale_id
    JOIN edges e ON e.id = rl.edge_id
    WHERE r.org_id = ${orgId} AND r.state = 'drafted' AND e.state = 'active'
  `;

  /**
   * Corrections are the compounding asset: every drift finding a human
   * resolved is company-specific judgment a competitor cannot crawl. Agent
   * dismissals are excluded — they clear a queue, they are not knowledge.
   */
  const [corrections] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM drift_findings
    WHERE org_id = ${orgId}
      AND state IN ('corrected', 'dismissed')
      AND dismissed_by IS DISTINCT FROM 'reviewer'
  `;

  const total = edges?.n ?? 0;

  return {
    revertsExecuted: reverts?.n ?? 0,
    mttdMs: {
      push: percentiles(byPath.push),
      poll: percentiles(byPath.poll),
    },
    mttdSkewExcluded: skew?.n ?? 0,
    mttrMs: percentiles(repairRows.map((r) => Number(r.ms))),
    highImpactReviewed: highImpact?.n ?? 0,
    coverageConfirmed: total === 0 ? 0 : (confirmed?.n ?? 0) / total,
    coveragePending: total === 0 ? 0 : (pending?.n ?? 0) / total,
    totalEdges: total,
    correctionsCaptured: corrections?.n ?? 0,
    /**
     * Null until 11.6's backtest harness exists to ground it. The type permits
     * a value only alongside `modelled: true`, so whenever this is filled in
     * it cannot reach a surface unlabeled.
     */
    incidentsAvoidedModelled: null,
  };
}
