import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { UpstreamError, UserError } from "../../errors.js";
import { pinnedFetch } from "../../net/pinned-fetch.js";

/**
 * Slack OAuth v2, so connecting is a button rather than a token paste.
 *
 * Two tokens come back and both are kept, because they buy different things:
 *
 *   access_token              bot   -> stored as `oauth_access`
 *   authed_user.access_token  user  -> stored as `oauth_user_access`
 *
 * The user token is the one that matters for quality. Slack's search.messages
 * only accepts a user token, so without it the Historian falls back to walking
 * each channel's history message by message — which is what SLACK_SCAN_MESSAGES
 * caps at 2000. Both credential names are the ones the Historian and Reflex
 * already look up; nothing downstream changes.
 */

/**
 * Bot scopes: list channels, read history only where an admin picks, and join
 * a public channel.
 *
 * `channels:join` is what makes the picker work rather than merely record an
 * intent. Slack returns not_in_channel for conversations.history on a channel
 * the bot is not a member of, so ticking a box without joining produces a
 * scope row, a green checkbox, and zero messages.
 */
export const BOT_SCOPES = [
  "channels:read",
  "channels:history",
  "channels:join",
  // Private channels are a separate scope family in Slack, and asking
  // conversations.list for private_channel without them fails the whole call
  // with missing_scope rather than returning the public ones. The app still
  // cannot add itself to a private channel — these only take effect once a
  // human invites it.
  "groups:read",
  "groups:history",
  /**
   * Alerting. These were declared on the descriptor and shown to the customer
   * from day one but never actually requested, so a workspace connected with
   * the button got a bot token that could not post: Slack answers 200 with
   * `ok:false, error:"missing_scope"`, the helper returns null, and nothing
   * logs it or changes the connector's status. Reflex alerting was silently
   * dead for every OAuth-connected org.
   *
   * `scopes.test.ts` now asserts this list covers the descriptor, because the
   * descriptor is what the settings page shows a security reviewer.
   */
  "chat:write",
  "im:write",
  "users:read",
  "users:read.email",
  "team:read",
];

/** User scope: the search API, which is the good retrieval path. */
export const USER_SCOPES = ["search:read"];

export function oauthConfigured(): boolean {
  return Boolean(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET);
}

export function redirectUri(): string {
  if (!config.PUBLIC_API_URL) {
    throw new UserError(
      "PUBLIC_API_URL is not set, so there is no address to send Slack back to. It must match the redirect URL registered on the Slack app exactly.",
    );
  }
  return `${config.PUBLIC_API_URL.replace(/\/$/, "")}/api/connectors/slack/oauth/callback`;
}

/**
 * The state parameter carries the org, signed.
 *
 * It has to, rather than being a random value looked up against the session:
 * Slack redirects the browser to PUBLIC_API_URL, which during development is a
 * tunnel hostname and never the origin the session cookie was set on. So the
 * callback arrives with no cookie, and the only trustworthy thing it holds is
 * what we signed before sending the user away.
 *
 * Signed with SESSION_SECRET, and short lived, so a captured state cannot be
 * replayed tomorrow to attach a workspace to somebody else's organisation.
 */
const STATE_TTL_MS = 10 * 60_000;

/**
 * The state, plus the nonce that must come back in a cookie.
 *
 * Signing the org alone defeats forgery but not confusion: an attacker could
 * start their own connect flow, take the signed state out of the redirect, and
 * get a victim's Slack admin to approve *that* authorize URL. The callback
 * would then bind the victim's workspace tokens to the attacker's org, and the
 * attacker could read that workspace through the Historian.
 *
 * The remedy is to prove the browser completing the flow is the one that
 * started it. The session cookie cannot do that — Slack returns to
 * PUBLIC_API_URL, which in development is a tunnel host that never saw it — so
 * a short-lived nonce cookie is set on the API origin instead, and the
 * callback requires the nonce inside the signed state to match it.
 */
export function signState(orgId: number): { state: string; nonce: string } {
  const nonce = randomBytes(18).toString("base64url");
  const payload = `${orgId}.${Date.now()}.${nonce}`;
  const mac = createHmac("sha256", config.SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return { state: `${payload}.${mac}`, nonce };
}

export function verifyState(state: string, presentedNonce: string | undefined): number {
  const parts = state.split(".");
  if (parts.length !== 4) throw new UserError("Malformed OAuth state");

  const [orgId, issuedAt, nonce, mac] = parts as [string, string, string, string];
  const payload = `${orgId}.${issuedAt}.${parts[2]}`;
  const expected = createHmac("sha256", config.SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UserError("OAuth state failed verification");
  }

  if (Date.now() - Number(issuedAt) > STATE_TTL_MS) {
    throw new UserError("This OAuth link expired. Start the connection again.");
  }

  /**
   * Checked after the MAC, so this compares a value we signed rather than one
   * an attacker chose. Without it a valid signature is enough on its own, and
   * a signature the attacker obtained legitimately for their own org is exactly
   * what the hijack uses.
   */
  const expectedNonce = Buffer.from(nonce);
  const gotNonce = Buffer.from(presentedNonce ?? "");
  if (
    gotNonce.length !== expectedNonce.length ||
    !timingSafeEqual(gotNonce, expectedNonce)
  ) {
    throw new UserError(
      "This authorization did not start in this browser. Begin the connection from Sadhak and approve it in the same browser.",
    );
  }

  const parsed = Number(orgId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserError("OAuth state carried no usable organisation");
  }
  return parsed;
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID ?? "",
    scope: BOT_SCOPES.join(","),
    user_scope: USER_SCOPES.join(","),
    redirect_uri: redirectUri(),
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export interface SlackGrant {
  teamName: string;
  botToken: string;
  userToken: string | null;
}

/**
 * Exchanges the code. Through pinnedFetch like every other outbound call, so
 * the egress guard sees it: this posts a client secret, and it may only go to
 * the address the guard resolved.
 */
export async function exchangeCode(code: string): Promise<SlackGrant> {
  const response = await pinnedFetch(`${config.SLACK_API_BASE_URL}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.SLACK_CLIENT_ID ?? "",
      client_secret: config.SLACK_CLIENT_SECRET ?? "",
      code,
      redirect_uri: redirectUri(),
    }).toString(),
  });

  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    team?: { name?: string };
    authed_user?: { access_token?: string };
  };

  // Slack answers 200 with ok:false, so the status code proves nothing.
  if (!body.ok || !body.access_token) {
    throw new UserError(`Slack refused the authorization: ${body.error ?? "unknown"}`);
  }

  return {
    teamName: body.team?.name ?? "Slack",
    botToken: body.access_token,
    userToken: body.authed_user?.access_token ?? null,
  };
}

interface SlackChannelList {
  ok: boolean;
  error?: string;
  channels?: Array<{
    id: string;
    name: string;
    is_private?: boolean;
    num_members?: number;
  }>;
}

/** Pages beyond this are a workspace we should not be enumerating in one go. */
const MAX_CHANNEL_PAGES = 20;

async function conversationsList(
  botToken: string,
  types: string,
): Promise<SlackChannelList> {
  const channels: NonNullable<SlackChannelList["channels"]> = [];
  let cursor: string | undefined;

  /**
   * Paged. A single `limit=200` call silently truncated any workspace with
   * more channels than that, and the picker gave no sign that the rest
   * existed — an admin simply could not select a channel Sadhak had not
   * happened to list.
   */
  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "200",
      exclude_archived: "true",
      types,
    });
    if (cursor) params.set("cursor", cursor);

    const response = await pinnedFetch(
      `${config.SLACK_API_BASE_URL}/conversations.list?${params.toString()}`,
      { headers: { authorization: `Bearer ${botToken}` } },
    );

    // Slack answers application errors with 200 and ok:false, so a non-2xx is
    // an outage or a proxy — and its body is HTML, which would otherwise throw
    // a raw SyntaxError out of a connector:manage route.
    if (!response.ok) {
      throw new UpstreamError(
        `Slack returned ${response.status} listing channels. This is Slack being unavailable rather than a configuration problem, so it is worth retrying.`,
      );
    }

    const body = (await response.json()) as SlackChannelList & {
      response_metadata?: { next_cursor?: string };
    };
    if (!body.ok) return body;

    channels.push(...(body.channels ?? []));

    cursor = body.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  return { ok: true, channels };
}

/**
 * The channels an admin can choose from, so nobody has to paste an ID.
 *
 * Falls back to public-only on missing_scope. Slack fails the entire call when
 * the requested types include private channels and the token lacks
 * groups:read — it does not return the public ones it could. A workspace
 * authorized before groups:read was requested would otherwise get an empty
 * picker and no way to tell why, so the retry keeps an older grant working
 * instead of demanding a re-authorization to list anything at all.
 */
export async function listChannels(
  botToken: string,
): Promise<Array<{ id: string; name: string; isPrivate: boolean; members: number }>> {
  let body = await conversationsList(botToken, "public_channel,private_channel");

  if (!body.ok && body.error === "missing_scope") {
    body = await conversationsList(botToken, "public_channel");
  }

  if (!body.ok) {
    throw new UserError(`Slack would not list channels: ${body.error ?? "unknown"}`);
  }

  return (body.channels ?? []).map((channel) => ({
    id: channel.id,
    name: channel.name,
    isPrivate: Boolean(channel.is_private),
    members: channel.num_members ?? 0,
  }));
}

/**
 * Puts the bot in the channel. Public channels only: Slack has no API by which
 * an app adds itself to a private conversation, which is the correct design and
 * means a private channel needs a human to `/invite` the app. The caller
 * surfaces that rather than retrying.
 *
 * `already_in_channel` is success. Anything else is reported verbatim, because
 * the error names the fix better than a paraphrase would.
 */
export async function joinChannel(
  botToken: string,
  channelId: string,
): Promise<{ joined: boolean; detail: string }> {
  const response = await pinnedFetch(`${config.SLACK_API_BASE_URL}/conversations.join`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ channel: channelId }).toString(),
  });

  const body = (await response.json()) as { ok: boolean; error?: string };
  if (body.ok) return { joined: true, detail: "in the channel" };
  if (body.error === "already_in_channel") {
    return { joined: true, detail: "already in the channel" };
  }
  if (body.error === "method_not_supported_for_channel_type") {
    return {
      joined: false,
      detail: "private channel — invite the app to it in Slack with /invite",
    };
  }
  return { joined: false, detail: body.error ?? "Slack refused the join" };
}
