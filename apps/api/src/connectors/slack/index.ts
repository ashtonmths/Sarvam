import { NotImplementedError } from "../../errors.js";
import type {
  Connector,
  ConnectorDescriptor,
  CrawlResult,
  ReadContext,
} from "../types.js";

/**
 * Descriptor and health only. Mining lands with Plan 10, alerting with Plan 9.
 * The scope list is the union both consume, declared now because a bot scope
 * added later forces a re-install in every already-connected workspace.
 */

export const descriptor: ConnectorDescriptor = {
  slug: "slack",
  displayName: "Slack",
  auth: "oauth2",
  readScopes: [
    {
      scope: "channels:read",
      purpose: "List channels so an admin can choose which to mine.",
    },
    {
      scope: "channels:history",
      purpose:
        "Read messages in the explicitly selected channels only, to mine rationale.",
    },
    {
      scope: "users:read",
      purpose: "Resolve author ids to names on a quoted rationale span.",
    },
    {
      scope: "team:read",
      purpose: "Read the workspace name shown in connector settings.",
    },
    {
      scope: "users:read.email",
      purpose: "Map a change author's email to a Slack user, so an alert can reach them.",
    },
  ],
  writeScopes: [
    {
      scope: "chat:write",
      purpose: "Post Sadhak's own alerts to a channel the customer picks.",
    },
    { scope: "im:write", purpose: "Open a DM with the actor of a flagged change." },
  ],
  webhooks: true,
  revertible: false,
};

export const ALLOWED_PATHS = [
  /^\/api\/auth\.test$/,
  /^\/api\/conversations\.list(\?.*)?$/,
];

export function authHeaders(secret: { reveal(): string }): Record<string, string> {
  return { authorization: `Bearer ${secret.reveal()}` };
}

export async function crawl(_ctx: ReadContext): Promise<CrawlResult> {
  throw new NotImplementedError("Slack mining lands with Plan 10");
}

export async function health(
  ctx: ReadContext,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const result = await ctx.http.getJson<{ ok: boolean; team?: string; error?: string }>(
      "/api/auth.test",
      ctx.signal,
    );
    return result.ok
      ? { ok: true, detail: `connected to ${result.team ?? "workspace"}` }
      : { ok: false, detail: result.error ?? "auth.test failed" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export const slackConnector: Connector = { descriptor, crawl, health };
