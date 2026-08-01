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

export interface SlackHit {
  text: string;
  author: string;
  ts: string;
  permalink: string;
}

const SLACK_API = "https://slack.com/api";

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
): Promise<{ messages: Array<{ text: string; author: string; permalink: string }> }> {
  const token =
    (await slackToken(ctx.orgId, "oauth_user_access")) ??
    (await slackToken(ctx.orgId, "oauth_access"));
  if (!token) return { messages: [] };

  const match = /archives\/([A-Z0-9]+)\/p(\d+)/.exec(permalink);
  if (!match?.[1] || !match[2]) return { messages: [] };

  const channel = match[1];
  const raw = match[2];
  const ts = `${raw.slice(0, 10)}.${raw.slice(10)}`;

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
      permalink: link,
    });
  }
  return { messages };
}

/** A model-supplied scope qualifier is stripped, never honored. */
function stripQualifiers(query: string): string {
  return query.replace(/\b(in|from|channel):\S+/gi, "").trim();
}
