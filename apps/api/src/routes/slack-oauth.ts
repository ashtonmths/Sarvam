import { connectorInstances, miningScopes } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/** Proves the browser finishing the flow is the one that started it. */
const OAUTH_NONCE_COOKIE = "sadhak_slack_oauth";

import { z } from "zod";
import { audit, auditSystem } from "../audit.js";
import { config } from "../config.js";
import {
  authorizeUrl,
  exchangeCode,
  joinChannel,
  listChannels,
  oauthConfigured,
  signState,
  verifyState,
} from "../connectors/slack/oauth.js";
import { db } from "../db.js";
import { UserError } from "../errors.js";
import { requireCapability } from "../middleware/auth.js";
import { getCredential, putCredential } from "../vault/vault.js";

/**
 * The two halves of Slack OAuth sit in different auth worlds, which is why
 * they are split across two routers rather than living together.
 *
 * `start` needs a signed-in admin: it is the request that decides which
 * organisation a workspace gets attached to. `callback` cannot require one -
 * Slack redirects the browser to PUBLIC_API_URL, which is not the origin the
 * session cookie was set on, so no cookie arrives. The org travels in the
 * signed state instead.
 */

/** The org's Slack bot token, or null when no workspace is connected. */
async function slackBotToken(orgId: number): Promise<string | null> {
  const [instance] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.orgId, orgId), eq(connectorInstances.connector, "slack")),
    )
    .limit(1);
  if (!instance) return null;

  const secret = await getCredential(
    orgId,
    instance.id,
    "read",
    "oauth_access",
    "settings.slack",
  );
  return secret?.reveal() ?? null;
}

export const slackOauthRoutes = new Hono();

/** Authenticated: mounted inside the session group. */
slackOauthRoutes.get(
  "/connectors/slack/oauth/start",
  requireCapability("connector:manage"),
  async (c) => {
    if (!oauthConfigured()) {
      throw new UserError(
        "Slack OAuth is not configured on this deployment. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, or paste a bot token instead.",
      );
    }
    const { state, nonce } = signState(c.get("orgId"));

    /**
     * Set on the API origin, which is where Slack returns to — the session
     * cookie lives on the web origin and never arrives at the callback. Short
     * lived and SameSite=Lax so it survives the top-level redirect back from
     * Slack while not riding along on cross-site subrequests.
     */
    setCookie(c, OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/api/connectors/slack/oauth",
      maxAge: 600,
    });

    return c.redirect(authorizeUrl(state));
  },
);

/** Is the button worth showing? Cheap, and keeps the decision on the server. */
slackOauthRoutes.get(
  "/connectors/slack/oauth/status",
  requireCapability("graph:read"),
  async (c) => c.json({ configured: oauthConfigured() }),
);

/**
 * The channels an admin picks from after connecting, so nobody types an ID.
 * Uses the bot token that OAuth just stored.
 */
slackOauthRoutes.get(
  "/connectors/slack/channels",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const token = await slackBotToken(orgId);
    // An empty list rather than a 404: "no workspace connected" is a state the
    // picker renders, not an error it has to interpret.
    if (!token) return c.json({ channels: [], selected: [] });

    const selected = await db
      .select({ scopeValue: miningScopes.scopeValue })
      .from(miningScopes)
      .where(and(eq(miningScopes.orgId, orgId), eq(miningScopes.connector, "slack")));

    return c.json({
      channels: await listChannels(token),
      selected: selected.map((row) => row.scopeValue),
    });
  },
);

/**
 * Ticking a channel is three things, and they have to happen together or the
 * result is a lie: record the mining scope, put the bot in the channel, and
 * report back which of those actually worked.
 *
 * Doing it in the client as three calls was the alternative, and it produces a
 * half-selected channel whenever the middle one fails.
 */
slackOauthRoutes.put(
  "/connectors/slack/channels/:channelId/mining",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const channelId = c.req.param("channelId");
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());

    if (!enabled) {
      const removed = await db
        .delete(miningScopes)
        .where(
          and(
            eq(miningScopes.orgId, orgId),
            eq(miningScopes.connector, "slack"),
            eq(miningScopes.scopeValue, channelId),
          ),
        )
        .returning({ id: miningScopes.id });

      if (removed.length > 0) {
        await audit(c, "mining_scope.removed", {
          kind: "mining_scope",
          id: removed[0]?.id ?? 0,
        });
      }
      // The bot stays in the channel. Leaving would be a visible action in
      // somebody's Slack, and unticking a box should not post "Sadhak left".
      return c.json({ enabled: false, detail: "no longer mined" });
    }

    const actor = c.get("actor");
    const [row] = await db
      .insert(miningScopes)
      .values({
        orgId,
        connector: "slack",
        scopeValue: channelId,
        addedBy: actor.type === "user" ? actor.email : `api_key:${actor.id}`,
      })
      .onConflictDoNothing()
      .returning();

    await audit(
      c,
      "mining_scope.added",
      { kind: "mining_scope", id: row?.id ?? 0 },
      { connector: "slack", scopeValue: channelId },
    );

    const secret = await slackBotToken(orgId);
    if (!secret) {
      return c.json({ enabled: true, joined: false, detail: "no Slack token stored" });
    }

    const join = await joinChannel(secret, channelId);
    return c.json({ enabled: true, joined: join.joined, detail: join.detail });
  },
);

/**
 * Unauthenticated by necessity, and safe because the state is signed. Mounted
 * beside the webhook routes for the same reason they are: the caller is a
 * third party, so the request authenticates itself rather than carrying a
 * session.
 */
export const slackOauthCallback = new Hono();

slackOauthCallback.get("/api/connectors/slack/oauth/callback", async (c) => {
  const web = config.WEB_ORIGINS[0] ?? "http://localhost:3000";
  const settings = `${web}/app/settings/connectors`;

  // Slack reports a user declining as a query parameter on a 200, so this is
  // the ordinary path rather than an error path.
  const denied = c.req.query("error");
  if (denied) {
    return c.redirect(`${settings}?slack=${encodeURIComponent(denied)}`);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) throw new UserError("Slack returned no code");

  const orgId = verifyState(state, getCookie(c, OAUTH_NONCE_COOKIE));
  // Single use: a state that has been redeemed must not be redeemable again.
  deleteCookie(c, OAUTH_NONCE_COOKIE, { path: "/api/connectors/slack/oauth" });
  const grant = await exchangeCode(code);

  // One Slack instance per org: connecting a second workspace replaces the
  // first rather than silently leaving two, because every consumer of these
  // credentials takes the first slack row it finds.
  const [existing] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.orgId, orgId), eq(connectorInstances.connector, "slack")),
    )
    .limit(1);

  let instanceId = existing?.id;
  if (instanceId) {
    await db
      .update(connectorInstances)
      .set({
        displayName: grant.teamName,
        status: "active",
        statusDetail: null,
        updatedAt: new Date(),
      })
      .where(eq(connectorInstances.id, instanceId));
  } else {
    const [row] = await db
      .insert(connectorInstances)
      .values({
        orgId,
        connector: "slack",
        displayName: grant.teamName,
        config: {},
        status: "active",
      })
      .returning();
    instanceId = row?.id;
  }

  if (!instanceId) throw new UserError("Could not record the Slack connection");

  await putCredential({
    orgId,
    instanceId,
    scope: "read",
    kind: "oauth_access",
    value: grant.botToken,
    createdBy: null,
  });

  // Absent when the admin declined the user scope. The bot token still works;
  // the Historian just takes the slower per-channel path instead of search.
  if (grant.userToken) {
    await putCredential({
      orgId,
      instanceId,
      scope: "read",
      kind: "oauth_user_access",
      value: grant.userToken,
      createdBy: null,
    });
  }

  // auditSystem, not audit: this request carries no session, so there is no
  // actor in context to attribute it to. The org comes from the signed state.
  await auditSystem(
    "connector.instance.created",
    orgId,
    { kind: "connector_instance", id: instanceId },
    { connector: "slack", via: "oauth", search: grant.userToken ? "user" : "bot" },
  );

  return c.redirect(`${settings}?slack=connected`);
});
