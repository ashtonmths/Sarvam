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

/**
 * What someone is proposing to do to a connected system.
 *
 * A discriminated union rather than a flat shape, because the operations that
 * make sense depend entirely on the target: a credential cannot be renamed and
 * a field cannot be revoked. Every enforcement door validates against this, so
 * a change the engine cannot receive is not composable by any caller.
 */
const actorFields = {
  actor: z.string().optional(),
  /** Set when the caller is an AI agent going through the proxy gate. */
  agent: z.string().optional(),
};

export const changeDescriptorSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("field"),
    operation: z.enum(["delete", "rename", "retype"]),
    connector: z.enum(["airtable", "postgres"]),
    externalId: z.string().min(1),
    newName: z.string().optional(),
    newType: z.string().optional(),
    ...actorFields,
  }),
  z.object({
    target: z.literal("workflow"),
    operation: z.enum(["modify", "disable", "delete"]),
    connector: z.literal("n8n"),
    externalId: z.string().min(1),
    ...actorFields,
  }),
  z.object({
    target: z.literal("credential"),
    operation: z.literal("revoke"),
    connector: z.enum(CONNECTOR_SLUGS),
    externalId: z.string().min(1),
    ...actorFields,
  }),
]);

export type ChangeDescriptor = z.infer<typeof changeDescriptorSchema>;

/** One edge traversed on the winning path to an impacted node. */
export interface EvidenceHop {
  edgeId: number;
  srcId: number;
  dstId: number;
  kind: string;
  confidence: number;
  provenance: string;
}

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
  /**
   * Distinct people whose *confirmed* rationale explains this node's path
   * edges. Knowledge-concentration v1: authorship only, which undercounts
   * understanding — the multi-signal version is Plan 11's. Zero means
   * unexplained, which is deliberately not the same as bus-factor-1.
   */
  busFactor: number;
  /** The winning path that produced this row's impact. */
  path: EvidenceHop[];
}

/** Why the verdict came out the way it did. Always populated, never a model. */
export interface Evidence {
  rule: string;
  nodeId: number;
  name: string;
  impact: number;
}

/**
 * The explanation is additive prose that can fail, time out, or be switched
 * off without the verdict noticing. `quota_exhausted` is a first-class state
 * rather than a flavour of `failed`: on free models the daily cap is hit
 * routinely, it recovers at a known time, and the UI should say
 * "explanations resume at reset" instead of "something broke".
 */
export const EXPLANATION_STATES = [
  "pending",
  "streamed",
  "failed",
  "disabled",
  "quota_exhausted",
] as const;
export type ExplanationState = (typeof EXPLANATION_STATES)[number];

export interface VerdictResult {
  /** Persisted verdict id. Every computation is auditable and replayable. */
  id: string;
  verdict: Verdict;
  change: ChangeDescriptor;
  impacted: BlastRow[];
  evidence: Evidence[];
  /** Milliseconds spent in traversal and scoring. Excludes any model call. */
  computedInMs: number;
  /** The graph generation this verdict was computed against. */
  graphVersion: number;
  /**
   * Human readable explanation, streamed in after the verdict renders. Null
   * until the Explainer responds, and stays null if it fails. The verdict is
   * complete without it.
   */
  explanation: string | null;
  explanationState: ExplanationState;
}

/* ------------------------------------------------------------ enforcement */

export const GATE_MODES = ["hard_gate", "proxy_gate", "mcp", "forward"] as const;
export type GateMode = (typeof GATE_MODES)[number];

/* --------------------------------------------------------------- metrics */

export interface Percentiles {
  median: number;
  p95: number;
  /** How many observations back this. A p95 over three rows is not a p95. */
  samples: number;
}

/**
 * Observable facts, with two honesty rules pushed into the type so breaking
 * them is a compile error rather than a code review someone has to catch.
 *
 * 1. **MTTD is per detection path.** Push (a webhook, ~2s) and poll (an
 *    interval, ~30s) are different mechanisms, and averaging them produces a
 *    headline number that describes neither. `Record<DetectPath, …>` makes a
 *    blended figure unrepresentable rather than merely discouraged.
 *
 * 2. **Anything modelled says so in its own type.** `modelled: true` is a
 *    literal, so a surface cannot render `incidentsAvoidedModelled` while
 *    pretending it is an observation — the label travels with the value.
 *
 * Nothing here is self-reported by a model, and nothing improves when the
 * product degrades.
 */
export type DetectPath = "push" | "poll";

export interface Metrics {
  /** Reverts that ran and the connector confirmed. Not reverts offered. */
  revertsExecuted: number;
  /**
   * detected_at − change_at, per path. `change_at` is the *vendor's* clock, so
   * this is approximate by construction; rows where the vendor clock is ahead
   * of ours are skew-flagged and excluded rather than silently swallowed.
   */
  mttdMs: Record<DetectPath, Percentiles | null>;
  /** Rows dropped from mttdMs for clock skew. Reported, never hidden. */
  mttdSkewExcluded: number;
  /** reverted_at − alerted_at: how long a human took plus how long we took. */
  mttrMs: Percentiles | null;
  /** Non-dry-run WARN or BLOCK decisions: impact surfaced to a human. */
  highImpactReviewed: number;
  /** Human authored and source linked only. Never summed with pending. */
  coverageConfirmed: number;
  coveragePending: number;
  totalEdges: number;
  /** Approved drift corrections and criticality overrides — the compounding asset. */
  correctionsCaptured: number;
  /**
   * Nodes where knowledge looks concentrated, as a **band** rather than a
   * count. "Bus factor: 1" is a claim the evidence cannot support; "high risk,
   * from one kind of evidence" is. See reviewer/concentration.ts.
   */
  knowledgeConcentration: {
    atRiskNodes: number;
    /** Nodes with no evidence either way — never counted as at risk. */
    unknownNodes: number;
  };
  /**
   * The only modelled number. Null until a backtest harness exists to ground
   * it — an unbacked estimate is worse than an absent one.
   */
  incidentsAvoidedModelled: { value: number; modelled: true } | null;
}
