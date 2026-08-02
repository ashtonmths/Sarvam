import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type Capability,
  capabilitiesFor,
  INTEGRATION_CAPABILITIES,
  isCapability,
  type Role,
} from "@sadhak/shared/rbac";
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
} from "@sadhak/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { resolveSession, SESSION_COOKIE } from "../auth/session.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { issuer } from "./oauth-metadata.js";

/**
 * The authorization server.
 *
 * Sadhak is both the resource and the issuer, which keeps this small: there is
 * no federation, no consent to a third party's idea of identity, just "this
 * person, signed in here, is letting that client act as them with these
 * capabilities". The credential it produces resolves to the same
 * `{ orgId, scopes }` an API key does, so nothing downstream learns a second
 * authorization model — `requireScope` is unchanged and unaware.
 *
 * The consent screen is served from here rather than from the web app because
 * the session cookie is host-only on the API's origin. A page on
 * sadhak.online could not read it, and moving the flow there would mean
 * either widening the cookie to the parent domain or inventing a handoff —
 * both worse than rendering one form from the origin that already knows who
 * you are.
 */

export const oauthRoutes = new Hono();

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mint(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time compare of two hex digests of equal length. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** OAuth errors are a JSON shape of their own, not this API's RFC 9457 one. */
function oauthError(
  c: Context,
  status: 400 | 401 | 403,
  error: string,
  description: string,
) {
  return c.json({ error, error_description: description }, status);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ *
 * Registration (RFC 7591)
 * ------------------------------------------------------------------ */

const registerInput = z.object({
  client_name: z.string().min(1).max(200).default("Unnamed client"),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  grant_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.enum(["client_secret_post", "none"]).optional(),
});

/**
 * A redirect_uri must be https, or loopback for a client running on someone's
 * machine. Anything else is a plaintext hop carrying an authorization code.
 */
function redirectUriIsAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  );
}

oauthRoutes.post("/oauth/register", async (c) => {
  const body = registerInput.parse(await c.req.json());

  const bad = body.redirect_uris.find((uri) => !redirectUriIsAllowed(uri));
  if (bad) {
    return oauthError(
      c,
      400,
      "invalid_redirect_uri",
      `${bad} is not https and is not a loopback address`,
    );
  }

  const isPublic = body.token_endpoint_auth_method === "none";
  const clientId = `sadhak-client-${mint().slice(0, 22)}`;
  const secret = isPublic ? null : mint();
  const registrationToken = mint();

  const [row] = await db
    .insert(oauthClients)
    .values({
      clientId,
      secretHash: secret ? sha256(secret) : null,
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      grantTypes: body.grant_types ?? ["authorization_code", "refresh_token"],
      registrationTokenHash: sha256(registrationToken),
    })
    .returning({ id: oauthClients.id });

  if (!row) return oauthError(c, 400, "invalid_request", "could not register client");

  return c.json(
    {
      client_id: clientId,
      ...(secret ? { client_secret: secret } : {}),
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? "client_secret_post",
      registration_access_token: registrationToken,
      registration_client_uri: `${issuer()}/oauth/register/${clientId}`,
    },
    201,
  );
});

/* ------------------------------------------------------------------ *
 * Authorize
 * ------------------------------------------------------------------ */

const authorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().optional(),
});

/**
 * The scopes this grant may carry: what the client asked for, narrowed to what
 * an integration may ever hold, narrowed again to what this person can
 * actually do. A viewer consenting to `connector:manage` does not create that
 * power — the grant is capped by the role, so a token can never exceed the
 * human behind it.
 */
function grantableScopes(requested: string[], role: Role): Capability[] {
  const mine = capabilitiesFor(role);
  return requested
    .filter((s): s is Capability => isCapability(s))
    .filter((s) => (INTEGRATION_CAPABILITIES as readonly string[]).includes(s))
    .filter((s) => mine.includes(s));
}

oauthRoutes.get("/oauth/authorize", async (c) => {
  const parsed = authorizeQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return oauthError(
      c,
      400,
      "invalid_request",
      parsed.error.issues[0]?.message ?? "bad request",
    );
  }
  const q = parsed.data;

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, q.client_id))
    .limit(1);
  if (!client) return oauthError(c, 400, "invalid_client", "unknown client_id");

  // Exact match, never a prefix. This check is the whole reason an attacker
  // cannot point a legitimate client's code at their own server.
  if (!client.redirectUris.includes(q.redirect_uri)) {
    return oauthError(
      c,
      400,
      "invalid_request",
      "redirect_uri is not registered for this client",
    );
  }

  const token = getCookie(c, SESSION_COOKIE);
  const actor = token ? await resolveSession(token) : null;
  if (!actor?.orgId || !actor.role) {
    // Send them to sign in, and come back to exactly this request.
    const back = `${issuer()}${c.req.path}?${new URL(c.req.url).searchParams.toString()}`;
    const webOrigin = config.WEB_ORIGINS[0] ?? "https://sadhak.online";
    return c.redirect(`${webOrigin}/signin?next=${encodeURIComponent(back)}`, 302);
  }

  const requested = (q.scope ?? "graph:read").split(/[\s+]+/).filter(Boolean);
  const granted = grantableScopes(requested, actor.role);
  if (granted.length === 0) {
    return oauthError(
      c,
      400,
      "invalid_scope",
      "none of the requested scopes are available to you",
    );
  }

  return c.html(
    consentPage({ client: client.clientName, scopes: granted, query: c.req.query() }),
  );
});

function consentPage(input: {
  client: string;
  scopes: string[];
  query: Record<string, string>;
}): string {
  const hidden = Object.entries(input.query)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`,
    )
    .join("");
  const list = input.scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorise ${escapeHtml(input.client)}</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem}
 h1{font-size:1.25rem} code{font-family:ui-monospace,monospace}
 ul{padding-left:1.2rem} button{font:inherit;padding:.6rem 1.1rem;margin-right:.5rem;cursor:pointer}
 .deny{background:none;border:1px solid currentColor}
</style></head><body>
<h1>${escapeHtml(input.client)} wants to act as you in Sadhak</h1>
<p>It is asking for:</p>
<ul>${list}</ul>
<p>It will be able to do these things without asking again, until you revoke it.
Nothing here lets it execute a change: the gate still decides that.</p>
<form method="post" action="/oauth/authorize">${hidden}
 <button name="decision" value="allow" type="submit">Allow</button>
 <button name="decision" value="deny" type="submit" class="deny">Deny</button>
</form>
</body></html>`;
}

oauthRoutes.post("/oauth/authorize", async (c) => {
  const form = await c.req.parseBody();
  const asQuery = Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;

  const parsed = authorizeQuery.safeParse(asQuery);
  if (!parsed.success) {
    return oauthError(c, 400, "invalid_request", "the consent form was incomplete");
  }
  const q = parsed.data;

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, q.client_id))
    .limit(1);
  if (!client) return oauthError(c, 400, "invalid_client", "unknown client_id");
  if (!client.redirectUris.includes(q.redirect_uri)) {
    return oauthError(
      c,
      400,
      "invalid_request",
      "redirect_uri is not registered for this client",
    );
  }

  const token = getCookie(c, SESSION_COOKIE);
  const actor = token ? await resolveSession(token) : null;
  if (!actor?.orgId || !actor.role)
    return oauthError(c, 401, "access_denied", "not signed in");

  const back = new URL(q.redirect_uri);
  if (q.state) back.searchParams.set("state", q.state);

  if (asQuery.decision !== "allow") {
    back.searchParams.set("error", "access_denied");
    return c.redirect(back.toString(), 302);
  }

  const granted = grantableScopes(
    (q.scope ?? "graph:read").split(/[\s+]+/).filter(Boolean),
    actor.role,
  );
  if (granted.length === 0) {
    back.searchParams.set("error", "invalid_scope");
    return c.redirect(back.toString(), 302);
  }

  const code = mint();
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: sha256(code),
    clientId: client.id,
    userId: actor.userId,
    orgId: actor.orgId,
    scopes: granted,
    redirectUri: q.redirect_uri,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
    resource: q.resource ?? null,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  back.searchParams.set("code", code);
  return c.redirect(back.toString(), 302);
});

/* ------------------------------------------------------------------ *
 * Token
 * ------------------------------------------------------------------ */

async function clientFromCredentials(clientId: string, secret: string | undefined) {
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  if (!client) return null;
  // A confidential client must prove itself; a public one is held to PKCE
  // alone, which is what makes the code useless to anyone who intercepts it.
  if (client.secretHash) {
    if (!secret || !sameDigest(sha256(secret), client.secretHash)) return null;
  }
  return client;
}

async function issueTokens(input: {
  clientId: number;
  userId: number;
  orgId: number;
  scopes: string[];
}) {
  const accessToken = mint();
  const refreshToken = mint();

  await db.insert(oauthAccessTokens).values({
    tokenHash: sha256(accessToken),
    clientId: input.clientId,
    userId: input.userId,
    orgId: input.orgId,
    scopes: input.scopes,
    expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
  });
  const [refreshRow] = await db
    .insert(oauthRefreshTokens)
    .values({
      tokenHash: sha256(refreshToken),
      clientId: input.clientId,
      userId: input.userId,
      orgId: input.orgId,
      scopes: input.scopes,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    })
    .returning({ id: oauthRefreshTokens.id });

  return {
    access_token: accessToken,
    token_type: "Bearer" as const,
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: input.scopes.join(" "),
    refreshId: refreshRow?.id,
  };
}

oauthRoutes.post("/oauth/token", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string | undefined>;
  const grantType = String(form.grant_type ?? "");
  const clientId = String(form.client_id ?? "");
  const clientSecret = form.client_secret ? String(form.client_secret) : undefined;

  const client = await clientFromCredentials(clientId, clientSecret);
  if (!client)
    return oauthError(c, 401, "invalid_client", "client authentication failed");

  if (grantType === "authorization_code") {
    const code = String(form.code ?? "");
    const verifier = String(form.code_verifier ?? "");
    const redirectUri = String(form.redirect_uri ?? "");
    if (!code || !verifier) {
      return oauthError(
        c,
        400,
        "invalid_request",
        "code and code_verifier are both required",
      );
    }

    const [row] = await db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, sha256(code)))
      .limit(1);
    if (!row || row.clientId !== client.id) {
      return oauthError(c, 400, "invalid_grant", "no such code");
    }

    // A code offered twice means it leaked. Everything it produced is suspect,
    // so the grant dies rather than the second attempt merely failing.
    if (row.consumedAt) {
      await db
        .update(oauthAccessTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oauthAccessTokens.userId, row.userId),
            eq(oauthAccessTokens.clientId, client.id),
          ),
        );
      await db
        .update(oauthRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oauthRefreshTokens.userId, row.userId),
            eq(oauthRefreshTokens.clientId, client.id),
          ),
        );
      return oauthError(c, 400, "invalid_grant", "this code was already used");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return oauthError(c, 400, "invalid_grant", "this code has expired");
    }
    if (redirectUri && redirectUri !== row.redirectUri) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "redirect_uri does not match the one authorised",
      );
    }

    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!sameDigest(sha256(challenge), sha256(row.codeChallenge))) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "code_verifier does not match the challenge",
      );
    }

    await db
      .update(oauthAuthorizationCodes)
      .set({ consumedAt: new Date() })
      .where(eq(oauthAuthorizationCodes.id, row.id));

    const issued = await issueTokens({
      clientId: client.id,
      userId: row.userId,
      orgId: row.orgId,
      scopes: row.scopes,
    });
    const { refreshId: _unused, ...body } = issued;
    return c.json(body);
  }

  if (grantType === "refresh_token") {
    const presented = String(form.refresh_token ?? "");
    const [row] = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, sha256(presented)))
      .limit(1);
    if (!row || row.clientId !== client.id || row.revokedAt) {
      return oauthError(c, 400, "invalid_grant", "no such refresh token");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return oauthError(c, 400, "invalid_grant", "this refresh token has expired");
    }

    const issued = await issueTokens({
      clientId: client.id,
      userId: row.userId,
      orgId: row.orgId,
      scopes: row.scopes,
    });
    // Rotation: the presented token is spent, and names its replacement so a
    // reuse can be traced to the chain it came from.
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date(), rotatedToId: issued.refreshId ?? null })
      .where(eq(oauthRefreshTokens.id, row.id));

    const { refreshId: _unused, ...body } = issued;
    return c.json(body);
  }

  return oauthError(c, 400, "unsupported_grant_type", `${grantType} is not supported`);
});

/* ------------------------------------------------------------------ *
 * Revocation (RFC 7009)
 * ------------------------------------------------------------------ */

oauthRoutes.post("/oauth/revoke", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string | undefined>;
  const presented = String(form.token ?? "");
  if (!presented) return c.body(null, 200);

  const hash = sha256(presented);
  const now = new Date();
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(
      and(eq(oauthAccessTokens.tokenHash, hash), isNull(oauthAccessTokens.revokedAt)),
    );
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      and(eq(oauthRefreshTokens.tokenHash, hash), isNull(oauthRefreshTokens.revokedAt)),
    );

  // RFC 7009: an unknown token is a success. Saying "no such token" would turn
  // this endpoint into an oracle for guessing them.
  return c.body(null, 200);
});

/* ------------------------------------------------------------------ *
 * Resolving a token, for the MCP route
 * ------------------------------------------------------------------ */

export interface OauthActor {
  orgId: number;
  userId: number;
  scopes: string[];
  tokenId: number;
}

/** Null for anything expired, revoked or unknown — checked on every call. */
export async function resolveAccessToken(presented: string): Promise<OauthActor | null> {
  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.tokenHash, sha256(presented)))
    .limit(1);
  if (!row || row.revokedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  await db
    .update(oauthAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthAccessTokens.id, row.id));

  return { orgId: row.orgId, userId: row.userId, scopes: row.scopes, tokenId: row.id };
}
