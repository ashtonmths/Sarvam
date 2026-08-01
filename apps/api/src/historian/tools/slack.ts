import { connectorInstances, miningScopes } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { getCredential } from "../../vault/vault.js";
import type { LoopCtx } from "./execute.js";

/**
 * Slack mining. Two honest paths, because `search.messages` requires a **user**
 * token with `search:read` — bot tokens cannot call it.
 *
 * Either way, the channel list comes from `mining_scopes` server-side. A
 * model-supplied channel qualifier is never honored, so no tool argument can
 * widen what Historian may read.
 */

/**
 * Field names are snake_case because this object is serialised straight to the
 * model, and `authored_at` is the argument name `propose_rationale` expects
 * back. Making them match is what stops the model reformatting a timestamp.
 */
export interface SlackHit {
  text: string;
  author: string;
  ts: string;
  authored_at: string | null;
  permalink: string;
}

/**
 * Slack's `ts` is "<epoch seconds>.<microseconds>" and doubles as a message id.
 * Only the seconds half is a time; the rest disambiguates messages within the
 * same second. Parsed by splitting rather than with parseFloat so the original
 * string is never round-tripped through a float — that is what silently
 * corrupts it when it is used as an id.
 */
export function tsToIso(ts: string): string | null {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Overridable so the agent evals can serve planted evidence from a local
 * fixture server. Goes through `config` rather than being read here, because
 * the lint rule that confines `process.env` to one module is what makes the
 * env schema trustworthy, and a seam worth having is a seam worth documenting.
 */
const SLACK_API = config.SLACK_API_BASE_URL;

async function slackToken(
  orgId: number,
  kind: "oauth_user_access" | "oauth_access",
): Promise<string | null> {
  const [instance] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.orgId, orgId), eq(connectorInstances.connector, "slack")),
    )
    .limit(1);
  if (!instance) return null;

  const secret = await getCredential(orgId, instance.id, "read", kind, "historian.slack");
  return secret?.reveal() ?? null;
}

async function scopedChannels(orgId: number): Promise<string[]> {
  const rows = await db
    .select({ value: miningScopes.scopeValue })
    .from(miningScopes)
    .where(and(eq(miningScopes.orgId, orgId), eq(miningScopes.connector, "slack")));
  return rows.map((r) => r.value);
}

export async function searchSlack(ctx: LoopCtx, query: string): Promise<SlackHit[]> {
  const channels = await scopedChannels(ctx.orgId);
  if (channels.length === 0) return [];

  const userToken = await slackToken(ctx.orgId, "oauth_user_access");
  if (userToken) return searchViaApi(userToken, query, channels, ctx.signal);

  const botToken = await slackToken(ctx.orgId, "oauth_access");
  if (botToken) return scanChannels(botToken, query, channels, ctx.signal);

  return [];
}

/** Preferred path: the qualifiers are built server-side from the scope list. */
async function searchViaApi(
  token: string,
  query: string,
  channels: string[],
  signal?: AbortSignal,
): Promise<SlackHit[]> {
  const scoped = `${stripQualifiers(query)} ${channels.map((c) => `in:${c}`).join(" ")}`;
  const url = `${SLACK_API}/search.messages?query=${encodeURIComponent(scoped)}&count=10`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return [];

  const body = (await res.json()) as {
    ok?: boolean;
    messages?: {
      matches?: Array<{
        text?: string;
        username?: string;
        ts?: string;
        permalink?: string;
      }>;
    };
  };
  if (!body.ok) return [];

  return (body.messages?.matches ?? [])
    .filter((m) => m.permalink && m.text)
    .slice(0, 10)
    .map((m) => ({
      text: (m.text ?? "").slice(0, 500),
      author: m.username ?? "unknown",
      ts: m.ts ?? "",
      authored_at: m.ts ? tsToIso(m.ts) : null,
      permalink: m.permalink as string,
    }));
}

/** Fallback for bot-token-only orgs: bounded scan, filtered in memory. */
async function scanChannels(
  token: string,
  query: string,
  channels: string[],
  signal?: AbortSignal,
): Promise<SlackHit[]> {
  const terms = stripQualifiers(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SlackHit[] = [];
  const perChannel = Math.max(
    1,
    Math.floor(config.SLACK_SCAN_MESSAGES / channels.length),
  );

  for (const channel of channels) {
    const url = `${SLACK_API}/conversations.history?channel=${encodeURIComponent(channel)}&limit=${Math.min(perChannel, 200)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) continue;

    const body = (await res.json()) as {
      ok?: boolean;
      messages?: Array<{ text?: string; user?: string; ts?: string }>;
    };
    if (!body.ok) continue;

    for (const message of body.messages ?? []) {
      const text = message.text ?? "";
      const lower = text.toLowerCase();
      if (!terms.some((term) => lower.includes(term))) continue;

      const permalink = await getPermalink(token, channel, message.ts ?? "", signal);
      if (!permalink) continue;

      hits.push({
        text: text.slice(0, 500),
        author: message.user ?? "unknown",
        ts: message.ts ?? "",
        authored_at: message.ts ? tsToIso(message.ts) : null,
        permalink,
      });
      if (hits.length >= 10) return hits;
    }
  }

  // Nothing from the scan persists except the final quoted span — pointers,
  // never archives.
  return hits;
}

async function getPermalink(
  token: string,
  channel: string,
  ts: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!ts) return null;
  const res = await fetch(
    `${SLACK_API}/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`,
    { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { ok?: boolean; permalink?: string };
  return body.ok ? (body.permalink ?? null) : null;
}

export async function readThread(
  ctx: LoopCtx,
  permalink: string,
): Promise<{
  messages: Array<{
    text: string;
    author: string;
    authored_at: string | null;
    permalink: string;
  }>;
}> {
  const token =
    (await slackToken(ctx.orgId, "oauth_user_access")) ??
    (await slackToken(ctx.orgId, "oauth_access"));
  if (!token) return { messages: [] };

  const match = /archives\/([A-Z0-9]+)\/p(\d+)/.exec(permalink);
  if (!match?.[1] || !match[2]) return { messages: [] };

  const channel = match[1];
  const raw = match[2];
  const messageTs = `${raw.slice(0, 10)}.${raw.slice(10)}`;

  /**
   * `conversations.replies` wants the *parent's* ts. A permalink to a reply
   * carries the reply's ts in the path and the parent's in `?thread_ts=`, so
   * using the path value returned just the one message the caller already had
   * — a silent no-op for exactly the threaded discussions this tool exists to
   * read, and the model would then give up for lack of context.
   */
  const threadTs = new URL(permalink).searchParams.get("thread_ts");
  const ts = threadTs ?? messageTs;

  const channels = await scopedChannels(ctx.orgId);
  if (!channels.includes(channel)) return { messages: [] };

  const res = await fetch(
    `${SLACK_API}/conversations.replies?channel=${channel}&ts=${ts}&limit=50`,
    {
      headers: { authorization: `Bearer ${token}` },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
  );
  if (!res.ok) return { messages: [] };

  const body = (await res.json()) as {
    ok?: boolean;
    messages?: Array<{ text?: string; user?: string; ts?: string }>;
  };
  if (!body.ok) return { messages: [] };

  const messages = [];
  for (const message of body.messages ?? []) {
    const link = await getPermalink(token, channel, message.ts ?? "", ctx.signal);
    if (!link) continue;
    messages.push({
      text: (message.text ?? "").slice(0, 500),
      author: message.user ?? "unknown",
      authored_at: message.ts ? tsToIso(message.ts) : null,
      permalink: link,
    });
  }
  return { messages };
}

/** A model-supplied scope qualifier is stripped, never honored. */
function stripQualifiers(query: string): string {
  return query.replace(/\b(in|from|channel):\S+/gi, "").trim();
}
