/**
 * Client-side mirror of the real verdict kernel (apps/api/src/sentinel/score.ts)
 * over the mock graph. Same constants, same rules, so the UI renders verdicts
 * with the exact semantics the engine will ship — swap the data source and the
 * screens don't change. The real app never computes verdicts client-side; this
 * file is the mock API, not a design proposal.
 */

import { EDGES, type GraphNode, NODES, nodeById } from "./data";

export const DECAY = 0.6;
export const BLOCKING_CONFIDENCE = 0.7;
export const BLOCK_IMPACT = 0.8;
export const WARN_TOTAL_IMPACT = 0.3;

export interface BlastRow {
  nodeId: number;
  name: string;
  kind: string;
  hops: number;
  pathConfidence: number;
  minEdgeConfidence: number;
  impact: number;
  busFactor: number;
}

export interface Evidence {
  rule: string;
  nodeId: number;
  name: string;
  impact: number;
}

export type Verdict = "APPROVE" | "WARN" | "BLOCK";

export interface MockVerdictResult {
  verdict: Verdict;
  impacted: BlastRow[];
  evidence: Evidence[];
  computedInMs: number;
}

export function decayedImpact(
  criticality: number,
  pathConfidence: number,
  hops: number,
): number {
  if (hops < 1) return criticality;
  return criticality * pathConfidence * DECAY ** (hops - 1);
}

/** BFS downstream of the changed node — the recursive CTE, in miniature. */
export function traverse(startNodeId: number): BlastRow[] {
  const best = new Map<
    number,
    { hops: number; pathConfidence: number; minEdge: number }
  >();
  const queue: Array<{
    id: number;
    hops: number;
    pathConfidence: number;
    minEdge: number;
  }> = [{ id: startNodeId, hops: 0, pathConfidence: 1, minEdge: 1 }];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.hops >= 6) continue;
    for (const e of EDGES) {
      if (e.source !== cur.id) continue;
      const next = {
        id: e.target,
        hops: cur.hops + 1,
        pathConfidence: cur.pathConfidence * e.confidence,
        minEdge: Math.min(cur.minEdge, e.confidence),
      };
      const seen = best.get(next.id);
      // Keep the strongest path: higher confidence wins, then fewer hops.
      if (
        !seen ||
        next.pathConfidence > seen.pathConfidence ||
        (next.pathConfidence === seen.pathConfidence && next.hops < seen.hops)
      ) {
        best.set(next.id, {
          hops: next.hops,
          pathConfidence: next.pathConfidence,
          minEdge: next.minEdge,
        });
        queue.push(next);
      }
    }
  }

  const rows: BlastRow[] = [];
  for (const [id, path] of best) {
    if (id === startNodeId) continue;
    const node = nodeById(id);
    if (node.kind === "person") continue;
    rows.push({
      nodeId: id,
      name: node.name,
      kind: node.kind,
      hops: path.hops,
      pathConfidence: path.pathConfidence,
      minEdgeConfidence: path.minEdge,
      impact: decayedImpact(node.criticality, path.pathConfidence, path.hops),
      busFactor: node.busFactor,
    });
  }
  return rows.sort((a, b) => b.impact - a.impact);
}

/** Verbatim port of the kernel's verdict() rules. */
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

export interface SimulatedDecision {
  result: MockVerdictResult;
  explanation: string;
}

export function simulate(nodeId: number, operation: string): SimulatedDecision {
  const start = performance.now();
  const impacted = traverse(nodeId);
  const { verdict: v, evidence } = verdict(impacted);
  const computedInMs = Math.max(1, Math.round(performance.now() - start)) + 24; // mock the CTE round-trip

  const node = nodeById(nodeId);
  const top = impacted[0];
  const explanation = buildExplanation(node, operation, v, impacted, top);

  return { result: { verdict: v, impacted, evidence, computedInMs }, explanation };
}

function buildExplanation(
  node: GraphNode,
  operation: string,
  v: Verdict,
  impacted: BlastRow[],
  top?: BlastRow,
): string {
  if (impacted.length === 0) {
    return `Nothing downstream depends on ${node.name}. The ${operation} is contained to the node itself, so the gate approves it without conditions.`;
  }
  const reach = `${impacted.length} downstream node${impacted.length === 1 ? "" : "s"} within ${Math.max(...impacted.map((r) => r.hops))} hops`;
  if (v === "BLOCK") {
    return `Deleting or altering ${node.name} reaches ${reach}, and ${top!.name} takes impact ${top!.impact.toFixed(2)} over trusted, statically-parsed edges — above the 0.8 blocking threshold. Marcus Chen's confirmed note explains why the dependency exists: the VAT report reads the row-level rate, and there is no fallback. The gate blocks this change; if the report is being retired, remove the view first and re-run.`;
  }
  if (v === "WARN") {
    return `A ${operation} on ${node.name} touches ${reach}. No single node crosses the blocking threshold over trusted edges, but the aggregate impact and at least one dependency only one person can explain mean this deserves a human look before it ships. Review the impacted list — the sole-source edges are the risk.`;
  }
  return `A ${operation} on ${node.name} reaches ${reach}, all at low decayed impact over the mapped paths. Nothing crosses a warning threshold. Approved — the change is visible on the map if you want to double-check the ripple.`;
}

/** Simulatable targets, per-kind operations mirroring the changeDescriptor union. */
export const OPERATIONS_BY_KIND: Record<string, string[]> = {
  field: ["delete", "rename", "retype"],
  table: ["delete", "rename"],
  view: ["delete", "rename"],
  workflow: ["modify", "disable", "delete"],
  step: ["modify", "delete"],
  base: ["delete"],
  channel: ["rename", "archive"],
  credential: ["revoke"],
};

export const SIMULATABLE_NODES = NODES.filter((n) => n.kind !== "person");
