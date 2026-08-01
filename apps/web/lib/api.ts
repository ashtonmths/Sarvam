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
  delete: <T>(path: string) => request<T>("DELETE", path),
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
