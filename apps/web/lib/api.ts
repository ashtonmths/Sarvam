import { API_URL } from "./env";

/**
 * The only fetch surface in the app. Renders the API's problem-details shape
 * into a typed error: `UserError` detail is safe to show verbatim, anything
 * 5xx gets a generic message.
 */

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Record<string, string[]>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
  }

  /** 4xx detail comes from the API and is meant for the user; 5xx never is. */
  get userMessage(): string {
    if (this.status >= 500) {
      return "Something went wrong on our side. The request id is in the console.";
    }
    return this.problem.detail ?? this.problem.title;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const problem = payload as ProblemDetails;
    throw new ApiError(response.status, {
      type: problem.type ?? "about:blank",
      title: problem.title ?? response.statusText,
      status: response.status,
      ...(problem.detail === undefined ? {} : { detail: problem.detail }),
      ...(problem.requestId === undefined ? {} : { requestId: problem.requestId }),
    });
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  // A body on DELETE is unusual but correct here: deleting an organisation
  // requires typing its name back, and that confirmation belongs in the
  // request rather than in a query string that lands in access logs.
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

/* ------------------------------------------------------- response shapes */

export interface MeResponse {
  user: { id: number; email: string; name: string };
  orgs: Array<{
    orgId: number;
    publicId: string;
    name: string;
    slug: string;
    role: "owner" | "admin" | "member" | "viewer";
  }>;
  activeOrgId: number | null;
  role: "owner" | "admin" | "member" | "viewer" | null;
  capabilities: string[];
}

export interface GraphStats {
  nodes: {
    total: number;
    byKind: Record<string, number>;
    byConnector: Record<string, number>;
    byState: Record<string, number>;
  };
  edges: {
    total: number;
    byProvenance: Record<string, number>;
    byState: Record<string, number>;
  };
  unresolvedRefs: number;
}

export interface GraphNode {
  id: number;
  kind: string;
  name: string;
  externalId: string;
  connector: string;
  criticality: number;
  criticalitySource: string;
  metadata: Record<string, unknown>;
  state: "active" | "stale";
  lastSeen: string;
}

export interface GraphEdge {
  id: number;
  srcId: number;
  dstId: number;
  kind: string;
  confidence: number;
  provenance: string;
  state: "active" | "stale";
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/* ------------------------------------------------------- verdict engine */

export interface EvidenceHop {
  edgeId: number;
  srcId: number;
  dstId: number;
  kind: string;
  confidence: number;
  provenance: string;
}

export interface BlastRow {
  nodeId: number;
  name: string;
  kind: string;
  hops: number;
  criticality: number;
  pathConfidence: number;
  minEdgeConfidence: number;
  impact: number;
  busFactor: number;
  path: EvidenceHop[];
}

export interface Evidence {
  rule: string;
  nodeId: number;
  name: string;
  impact: number;
}

export type VerdictName = "APPROVE" | "WARN" | "BLOCK";

export type ExplanationState =
  | "pending"
  | "streamed"
  | "failed"
  | "disabled"
  | "quota_exhausted";

export interface VerdictResult {
  id: string;
  verdict: VerdictName;
  change: Record<string, string>;
  impacted: BlastRow[];
  evidence: Evidence[];
  computedInMs: number;
  graphVersion: number;
  explanation: string | null;
  explanationState: ExplanationState;
}

export interface GateResponse {
  decision_id: number;
  verdict_id: string;
  verdict: VerdictName;
  evidence: Evidence[];
  impacted: BlastRow[];
  computed_in_ms: number;
  dry_run: boolean;
  replayed: boolean;
}

export interface DecisionRow {
  id: number;
  verdictId: string;
  mode: string;
  dryRun: boolean;
  actor: string | null;
  createdAt: string;
  verdict: VerdictName;
  computedInMs: number;
  change: Record<string, string>;
}

export interface DecisionDetail extends DecisionRow {
  impacted: BlastRow[];
  evidence: Evidence[];
  graphVersion: number;
  explanation: string | null;
  explanationState: ExplanationState;
  executedAt: string | null;
}

/* ------------------------------------------------------------ rationale */

export interface RationaleRow {
  id: number;
  body: string;
  sourceKind: string;
  sourceUrl: string;
  author: string | null;
  state: string;
  /** The agent's own confidence. Null for human-captured rationale. */
  confidence: number | null;
  createdAt: string;
  edgeId: number | null;
  srcId: number | null;
  dstId: number | null;
  edgeKind: string | null;
  srcName: string | null;
  dstName: string | null;
}

export interface Coverage {
  coverageConfirmed: number;
  coveragePending: number;
  totalEdges: number;
  note: string;
}

/* ------------------------------------------------------------- reflex */

export interface Incident {
  id: number;
  connector: string;
  target: string;
  operation: string;
  externalId: string;
  verdict: VerdictName | null;
  state: string;
  detectPath: string;
  blast: BlastRow[] | null;
  evidence: Evidence[] | null;
  actor: { name?: string; email?: string } | null;
  changeAt: string | null;
  detectedAt: string;
  acknowledgedBy: string | null;
  revertError: string | null;
  createdAt: string;
}

/* ---------------------------------------------------------- historian */

export type FindingState =
  | "open"
  | "investigating"
  | "corrected"
  | "dismissed"
  | "auto_dismissed";

export interface DriftFinding {
  id: number;
  kind: "hash_change" | "staleness" | "unresolved_ref";
  scope: string;
  state: FindingState;
  signature: string;
  documentedState: { hash: string | null } | null;
  liveState: {
    hash: string | null;
    name?: string;
    kind?: string;
    edgeCount?: number;
  } | null;
  dismissReason: string | null;
  budgetExhaustedAt: string | null;
  runId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  connectorInstanceId: number;
  connector: string;
  instanceName: string;
}

export interface Percentiles {
  median: number;
  p95: number;
  /** A p95 over three rows is not a p95, so the count travels with it. */
  samples: number;
}

/**
 * Mirrors `Metrics` in @sadhak/shared. Two shapes are deliberate: `mttdMs` is
 * keyed by detection path so a blended figure cannot be rendered, and anything
 * modelled carries `modelled: true` so it cannot be shown as an observation.
 */
export interface MetricsSummary {
  revertsExecuted: number;
  mttdMs: { push: Percentiles | null; poll: Percentiles | null };
  mttdSkewExcluded: number;
  mttrMs: Percentiles | null;
  highImpactReviewed: number;
  coverageConfirmed: number;
  coveragePending: number;
  totalEdges: number;
  correctionsCaptured: number;
  knowledgeConcentration: { atRiskNodes: number; unknownNodes: number };
  incidentsAvoidedModelled: { value: number; modelled: true } | null;
}

export interface SeriesPoint {
  day: string;
  value: number;
  meta: Record<string, unknown> | null;
}

export interface SeriesResponse {
  metric: string;
  from: string;
  to: string;
  points: SeriesPoint[];
}

export interface DriftSummary {
  open: number;
  investigating: number;
  corrected: number;
  dismissed: number;
  autoDismissed: number;
  instancesWatched: number;
  lastCheckedAt: string | null;
}

export interface HistorianRun {
  id: string;
  kind: string;
  state: string;
  edgesTotal: number;
  edgesProposed: number;
  edgesGaveUp: number;
  edgesSkippedQuota: number;
  requestsUsed: number;
  startedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunEdge {
  edgeId: number;
  loopRunId: string | null;
  outcome: string | null;
}

/** Server-Sent Events, typed. Terminal events are handed to the consumer and
 *  never swallowed — reconnecting into an exhausted quota is how a one-line
 *  state becomes an infinite spinner. */
export function subscribe(
  path: string,
  handlers: {
    onEvent: (event: string, data: Record<string, unknown>) => void;
    onError?: () => void;
  },
): () => void {
  const source = new EventSource(`${API_URL}${path}`, { withCredentials: true });

  const forward = (name: string) => {
    source.addEventListener(name, (event) => {
      try {
        handlers.onEvent(name, JSON.parse((event as MessageEvent).data as string));
      } catch {
        handlers.onEvent(name, {});
      }
    });
  };

  for (const name of [
    "delta",
    "done",
    "failed",
    "disabled",
    "quota_exhausted",
    "trace",
    "run",
    "ping",
  ]) {
    forward(name);
  }

  source.onerror = () => {
    handlers.onError?.();
    source.close();
  };

  return () => source.close();
}
