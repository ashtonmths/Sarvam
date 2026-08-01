import { z } from "zod";

/**
 * The contract between the verdict engine and everything that renders it.
 * Defined once here so the API and the UI cannot drift apart silently.
 */

export const VERDICTS = ["APPROVE", "WARN", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * The connector set, named once. The registry and the gate contract derive
 * from this, so they cannot disagree.
 */
export const CONNECTOR_SLUGS = [
  "n8n",
  "airtable",
  "postgres",
  "github",
  "slack",
] as const;
export type ConnectorSlug = (typeof CONNECTOR_SLUGS)[number];

/** What someone is proposing to do to a connected system. */
export const changeRequestSchema = z.object({
  connector: z.enum(CONNECTOR_SLUGS),
  operation: z.enum(["delete", "rename", "retype", "disable", "revoke"]),
  /** Stable id in the source system. Resolved to a node before traversal. */
  externalId: z.string().min(1),
  actor: z.string().optional(),
  /** Set when the caller is an AI agent going through the proxy gate. */
  agent: z.string().optional(),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

/** One reachable node in the blast radius, already scored. */
export interface BlastRow {
  nodeId: number;
  name: string;
  kind: string;
  hops: number;
  criticality: number;
  /** Product of edge confidences along the path that reached this node. */
  pathConfidence: number;
  /** Lowest edge confidence on that path. Gates whether it may cause a BLOCK. */
  minEdgeConfidence: number;
  /** criticality * pathConfidence * decay^(hops-1) */
  impact: number;
  /** Number of distinct people whose rationale explains this node's edges. */
  busFactor: number;
}

/** Why the verdict came out the way it did. Always populated, never a model. */
export interface Evidence {
  rule: string;
  nodeId: number;
  name: string;
  impact: number;
}

export interface VerdictResult {
  verdict: Verdict;
  change: ChangeRequest;
  impacted: BlastRow[];
  evidence: Evidence[];
  /** Milliseconds spent in traversal and scoring. Excludes any model call. */
  computedInMs: number;
  /**
   * Human readable explanation, streamed in after the verdict renders. Null
   * until the Explainer responds, and stays null if it fails. The verdict is
   * complete without it.
   */
  explanation: string | null;
}

/* --------------------------------------------------------------- metrics */

export interface Metrics {
  revertsExecuted: number;
  meanDetectToRevertMs: number | null;
  highImpactChangesReviewed: number;
  /** Human authored and source linked only. LLM drafts are counted separately. */
  coverageConfirmed: number;
  coveragePending: number;
  busFactorOneNodes: number;
}
