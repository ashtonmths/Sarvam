import Constants from "expo-constants";

/**
 * The mobile client talks to the same API the web app does.
 *
 * Auth is the one thing that differs. `POST /api/auth/signin` sets an httpOnly
 * cookie and does not return the token in its body, and the API's `Bearer`
 * header is reserved for API keys — a session token sent that way is rejected
 * by `verifyApiKey`. React Native's fetch has no cookie jar, so this module
 * captures `set-cookie` from the sign-in response and replays it as a `Cookie`
 * header on every subsequent request. No server change was needed for that.
 */

/** Production by default; `EXPO_PUBLIC_API_URL` points it at a local API. */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "https://api.sadhak.online";

const SESSION_COOKIE = "sadhak_session";

let sessionToken: string | null = null;

export function setSessionToken(token: string | null) {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** 401 means the stored session died; the caller signs out rather than retry. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Pulls our session cookie out of a `set-cookie` header of any shape. */
export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;,\\s]+)`));
  return match?.[1] ?? null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  if (sessionToken) headers.Cookie = `${SESSION_COOKIE}=${sessionToken}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    // A dead host and a flaky tunnel look identical here; say the reachable
    // thing rather than inventing a cause.
    throw new ApiError(0, `Cannot reach ${API_URL}`);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* a non-JSON error body is still an error */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
};

export interface SignInResult {
  user: { id: number; email: string; name: string };
  orgId: number | null;
  token: string;
}

/** Signs in and returns the captured session token alongside the user. */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new ApiError(0, `Cannot reach ${API_URL}`);
  }

  if (!res.ok) {
    throw new ApiError(res.status, res.status === 401 ? "Wrong email or password" : "Sign in failed");
  }

  const body = (await res.json()) as Omit<SignInResult, "token">;
  const token = readSessionCookie(res.headers.get("set-cookie"));
  if (!token) {
    throw new ApiError(500, "Signed in but no session cookie came back");
  }
  return { ...body, token };
}

/* ------------------------------------------------------------ API shapes */

export interface GraphStats {
  nodes: { total: number; byKind: Record<string, number>; byState: Record<string, number> };
  edges: { total: number; byProvenance: Record<string, number> };
  unresolvedRefs: number;
}

export type VerdictName = "APPROVE" | "WARN" | "BLOCK";

export interface DecisionRow {
  id: number;
  mode: string;
  dryRun: boolean;
  actor: string | null;
  createdAt: string;
  verdict: VerdictName;
  computedInMs: number;
  change: Record<string, string>;
}

export interface DriftSummary {
  open: number;
  investigating: number;
  corrected: number;
  lastCheckedAt: string | null;
}

export interface Coverage {
  coverageConfirmed: number;
  coveragePending: number;
  totalEdges: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
