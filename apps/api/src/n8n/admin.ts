import { config } from "../config.js";
import { UpstreamError } from "../errors.js";
import type { EgressOptions } from "../net/guard.js";
import { pinnedFetch } from "../net/pinned-fetch.js";

/**
 * The platform's own n8n, spoken to as the instance owner.
 *
 * This is deliberately not the n8n *connector*. The connector reads a
 * customer's own instance with a credential they supplied, scoped to
 * `GET /api/v1/workflows` and nothing else. This module holds the owner key
 * for the instance we operate, and it can create users — a capability that
 * must never be reachable from org-level config, which is why the base URL and
 * key come from the process environment rather than from a connector row.
 *
 * Everything here is written against responses the running 1.75.2 instance
 * actually returns. Where the published OpenAPI document disagrees, the
 * document is wrong and the difference is noted at the call site.
 */

/**
 * `allowHttp` with no `allowPrivateHosts` override, matching what
 * `egressOptionsFor` produces for n8n: the compose instance is reachable only
 * as `http://n8n:5678`, and which private hosts are permitted stays an
 * operator decision via EGRESS_ALLOW_PRIVATE_HOSTS.
 */
const EGRESS: EgressOptions = { allowHttp: true };

/** n8n's own cap. Asking for more is rejected outright rather than clamped. */
const PAGE_LIMIT = 100;

/**
 * Which instance, with whose authority.
 *
 * Made explicit because the two callers here must never share a key. User
 * provisioning speaks as the instance owner; execution polling speaks as the
 * org, with the key that org supplied. An owner key cannot be narrowed to one
 * tenant — `/api/v1/projects` is 403 without an enterprise licence — so a poll
 * that reached for the platform key would read every tenant's executions.
 */
export interface N8nConnection {
  baseUrl: string;
  apiKey: string;
  egress?: EgressOptions;
}

export function n8nAdminConfigured(): boolean {
  return Boolean(config.N8N_BASE_URL && config.N8N_API_KEY);
}

/** The owner connection. Provisioning only. */
function platformConnection(): N8nConnection {
  if (!config.N8N_BASE_URL) {
    throw new UpstreamError("N8N_BASE_URL is not configured");
  }
  if (!config.N8N_API_KEY) {
    throw new UpstreamError("N8N_API_KEY is not configured");
  }
  return { baseUrl: config.N8N_BASE_URL, apiKey: config.N8N_API_KEY };
}

function urlFor(connection: N8nConnection, path: string): URL {
  return new URL(path, `${connection.baseUrl.replace(/\/+$/, "")}/`);
}

async function n8nFetch(
  connection: N8nConnection,
  url: URL,
  init: { method?: string; body?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const response = await pinnedFetch(
    url.toString(),
    {
      ...(init.method ? { method: init.method } : {}),
      ...(init.body ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      headers: {
        "X-N8N-API-KEY": connection.apiKey,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    },
    connection.egress ?? EGRESS,
  );

  if (!response.ok) {
    // The body can carry the instance's own error text; the status is what
    // callers branch on, so the text is trimmed to keep it out of logs at
    // length.
    const detail = await response.text().catch(() => "");
    throw new UpstreamError(
      `n8n ${init.method ?? "GET"} ${url.pathname} failed: ${response.status} ${detail.slice(0, 200)}`,
      { status: response.status >= 500 ? 502 : 502 },
    );
  }

  // 204 on delete, and an empty body is not JSON.
  if (response.status === 204) return null;
  return (await response.json()) as unknown;
}

/* ------------------------------------------------------------------ users */

export interface N8nUser {
  id: string;
  email: string;
  /** Null once the invite has been accepted — n8n stops returning it. */
  inviteAcceptUrl: string | null;
  /**
   * The owner who issued the invite, parsed out of the accept URL.
   *
   * `POST /rest/invitations/:id/accept` requires it in the body and there is
   * no other endpoint that reports it, so the query string is the only source.
   */
  inviterId: string | null;
  /** False whenever SMTP is unconfigured, which is the default. */
  emailSent: boolean;
  /** True while the user exists but has never set a password. */
  pending: boolean;
}

function inviterIdFrom(inviteAcceptUrl: string | null | undefined): string | null {
  if (!inviteAcceptUrl) return null;
  try {
    return new URL(inviteAcceptUrl).searchParams.get("inviterId");
  } catch {
    return null;
  }
}

interface RawCreateEntry {
  user?: {
    id?: string;
    email?: string;
    inviteAcceptUrl?: string;
    emailSent?: boolean;
  };
  error?: string;
}

interface RawUserListEntry {
  id?: string;
  email?: string;
  isPending?: boolean;
}

/**
 * Invite a user, returning the n8n account either way.
 *
 * Two things about this endpoint are not in the OpenAPI document and both
 * matter, because jobs here are at-least-once and this call *will* be repeated:
 *
 *  1. It returns an *array* of `{user, error}`, not the bare `{user}` object
 *     the document describes.
 *  2. Re-inviting an address whose account has already been *accepted* returns
 *     an empty array — no user, no error. Read literally that is
 *     indistinguishable from failure, so the empty case falls through to a
 *     lookup rather than throwing. Re-inviting a still-pending address is
 *     harmless and returns the original id.
 *
 * `global:member` is the only role available here: `global:admin` requires the
 * enterprise `advancedPermissions` feature, and asking for it on a community
 * instance fails the whole call.
 */
export async function inviteN8nUser(
  email: string,
  signal?: AbortSignal,
): Promise<N8nUser> {
  const connection = platformConnection();
  const raw = await n8nFetch(connection, urlFor(connection, "api/v1/users"), {
    method: "POST",
    body: JSON.stringify([{ email, role: "global:member" }]),
    ...(signal ? { signal } : {}),
  });

  const entries: RawCreateEntry[] = Array.isArray(raw)
    ? (raw as RawCreateEntry[])
    : // Tolerated so a future n8n that matches its own document still works.
      [(raw ?? {}) as RawCreateEntry];

  const entry = entries[0];

  if (entry?.error) {
    throw new UpstreamError(`n8n refused to create ${email}: ${entry.error}`);
  }

  if (entry?.user?.id) {
    return {
      id: entry.user.id,
      email: entry.user.email ?? email,
      inviteAcceptUrl: entry.user.inviteAcceptUrl ?? null,
      inviterId: inviterIdFrom(entry.user.inviteAcceptUrl),
      emailSent: entry.user.emailSent ?? false,
      pending: true,
    };
  }

  // The already-accepted case. The account exists and is usable; it simply has
  // no invite left to hand back.
  const existing = await findN8nUserByEmail(email, signal);
  if (existing) return existing;

  throw new UpstreamError(
    `n8n returned no user for ${email} and none could be found afterwards`,
  );
}

/** Paged, because the lookup must not stop at the first hundred accounts. */
export async function findN8nUserByEmail(
  email: string,
  signal?: AbortSignal,
): Promise<N8nUser | null> {
  const wanted = email.toLowerCase();
  const connection = platformConnection();
  let cursor: string | undefined;

  for (let page = 0; page < 50; page += 1) {
    const url = urlFor(connection, "api/v1/users");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const body = (await n8nFetch(connection, url, {
      ...(signal ? { signal } : {}),
    })) as {
      data?: RawUserListEntry[];
      nextCursor?: string | null;
    };

    for (const row of body.data ?? []) {
      if (!row.id || (row.email ?? "").toLowerCase() !== wanted) continue;
      return {
        id: row.id,
        email: row.email ?? email,
        // Only ever returned at creation time.
        inviteAcceptUrl: null,
        inviterId: null,
        emailSent: false,
        pending: row.isPending ?? false,
      };
    }

    cursor = body.nextCursor ?? undefined;
    if (!cursor) break;
  }

  return null;
}

/* ------------------------------------------------------------- executions */

export interface N8nErrorExecution {
  id: number;
  workflowId: string;
  workflowName: string | null;
  mode: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  /** The node that threw, by name. */
  failedNode: string | null;
  errorMessage: string | null;
}

interface RawExecution {
  id?: number | string;
  workflowId?: number | string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
  workflowData?: { name?: string };
  data?: {
    resultData?: {
      lastNodeExecuted?: string;
      error?: { message?: string; description?: string; name?: string };
    };
  };
}

/**
 * An error message is one `JSON.stringify(row)` away from being customer data,
 * so it is bounded before it is ever written. Everything else in
 * `data.resultData.runData` — which is the actual payload of every node in the
 * run — is dropped at this boundary and never reaches a caller.
 */
const MAX_ERROR_MESSAGE = 500;

function extractFailure(raw: RawExecution): N8nErrorExecution | null {
  const id = Number(raw.id);
  if (!Number.isInteger(id)) return null;

  const result = raw.data?.resultData;
  const message = result?.error?.message ?? result?.error?.description ?? null;

  return {
    id,
    workflowId: String(raw.workflowId ?? ""),
    workflowName: raw.workflowData?.name ?? null,
    mode: raw.mode ?? null,
    startedAt: raw.startedAt ?? null,
    stoppedAt: raw.stoppedAt ?? null,
    failedNode: result?.lastNodeExecuted ?? null,
    errorMessage: message ? message.slice(0, MAX_ERROR_MESSAGE) : null,
  };
}

export interface ListErrorExecutionsOptions {
  /**
   * Stop as soon as an execution at or below this id is seen. n8n returns
   * executions newest-first and its ids are monotonic, so this turns a steady
   * state into a single page.
   */
  afterId?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

/**
 * Failed executions, newest first.
 *
 * `includeData` is required: without it n8n returns no `resultData`, and the
 * failing node and message — the only two fields worth keeping — are both
 * absent. It is also what makes the response large, which is why nothing
 * beyond those two fields survives `extractFailure`.
 */
export async function listErrorExecutions(
  connection: N8nConnection,
  options: ListErrorExecutionsOptions = {},
): Promise<N8nErrorExecution[]> {
  const afterId = options.afterId ?? 0;
  const maxPages = options.maxPages ?? 20;

  const found: N8nErrorExecution[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = urlFor(connection, "api/v1/executions");
    url.searchParams.set("status", "error");
    url.searchParams.set("includeData", "true");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const body = (await n8nFetch(connection, url, {
      ...(options.signal ? { signal: options.signal } : {}),
    })) as { data?: RawExecution[]; nextCursor?: string | null };

    const rows = body.data ?? [];
    let reachedKnown = false;

    for (const row of rows) {
      const failure = extractFailure(row);
      if (!failure) continue;
      if (failure.id <= afterId) {
        reachedKnown = true;
        continue;
      }
      found.push(failure);
    }

    // Everything from here down has been seen before.
    if (reachedKnown) break;

    cursor = body.nextCursor ?? undefined;
    if (!cursor) break;
  }

  return found;
}

export const __testing = { extractFailure, MAX_ERROR_MESSAGE };
