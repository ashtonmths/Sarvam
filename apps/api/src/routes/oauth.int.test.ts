import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { closePools, sql } from "../db.js";
import { onError } from "../http/middleware.js";
import { mcpRoutes } from "./mcp.js";
import { oauthRoutes } from "./oauth.js";
import { oauthMetadataRoutes } from "./oauth-metadata.js";

/**
 * The authorization server, exercised the way a connector drives it: discover,
 * register, consent, redeem, call.
 *
 * Against a real Postgres because every guarantee here is a row — a consumed
 * code, a revoked token, a grant capped to a role — and a mocked store would
 * only prove the mock agreed with itself. The negative cases carry the weight:
 * a flow that works is table stakes, and the reason to write an authorization
 * server test at all is the replay, the wrong verifier and the borrowed
 * redirect URI.
 */

const ISSUER = "https://api.test.sadhak.online";

/**
 * The two response shapes these tests read. Declared rather than indexed off a
 * `Record`, so a missing `client_id` is a type error here instead of an
 * `undefined` that quietly becomes the string "undefined" in a query string.
 */
interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  error?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
}
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function app() {
  const a = new Hono();
  a.onError(onError);
  a.route("/", oauthMetadataRoutes);
  a.route("/", oauthRoutes);
  a.route("/", mcpRoutes);
  return a;
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  const res = await app().request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "client_secret_post",
      ...overrides,
    }),
  });
  return { status: res.status, body: (await res.json()) as RegisteredClient };
}

async function seedPerson(role: "owner" | "viewer" = "owner") {
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme') RETURNING id
  `;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash)
    VALUES ('demo@example.com', 'Demo', 'scrypt$1$1$1$x$x') RETURNING id
  `;
  const orgId = Number(org?.id);
  const userId = Number(user?.id);
  await sql`INSERT INTO members (org_id, user_id, role) VALUES (${orgId}, ${userId}, ${role})`;
  const { token } = await createSession(userId, orgId);
  return { orgId, userId, cookie: `${SESSION_COOKIE}=${token}` };
}

function authorizeParams(
  clientId: string,
  challenge: string,
  scope = "graph:read gate:invoke",
) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state: "opaque-state",
  };
}

/** Drive the consent form and return the code the redirect carries. */
async function consent(
  params: Record<string, string>,
  cookie: string,
  decision = "allow",
): Promise<{
  status: number;
  location: string;
  code: string | null;
  error: string | null;
}> {
  const res = await app().request("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ ...params, decision }).toString(),
  });
  const location = res.headers.get("location") ?? "";
  const q = location ? new URL(location).searchParams : new URLSearchParams();
  return {
    status: res.status,
    location,
    code: q.get("code"),
    error: q.get("error"),
  };
}

async function redeem(body: Record<string, string>) {
  const res = await app().request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, body: (await res.json()) as TokenResponse };
}

async function callMcp(token: string) {
  return app().request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

beforeEach(async () => {
  await sql`TRUNCATE organizations, users, oauth_clients CASCADE`;
});

afterAll(async () => {
  await closePools();
});

describe("discovery", () => {
  it("points a client at the authorization server that guards this resource", async () => {
    const res = await app().request("/.well-known/oauth-protected-resource");
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
    };

    expect(res.status).toBe(200);
    expect(body.resource).toBe(`${ISSUER}/mcp`);
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  it("offers only S256, so a client cannot downgrade to a plaintext challenge", async () => {
    const res = await app().request("/.well-known/oauth-authorization-server");
    const body = (await res.json()) as {
      code_challenge_methods_supported: string[];
      grant_types_supported: string[];
    };

    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).not.toContain("implicit");
  });

  it("never advertises a capability an integration may not hold", async () => {
    // The key form deliberately offers four. OAuth advertising more would be a
    // way around that restriction rather than a second door to the same rooms.
    const res = await app().request("/.well-known/oauth-authorization-server");
    const body = (await res.json()) as { scopes_supported: string[] };

    expect(body.scopes_supported).not.toContain("org:delete");
    expect(body.scopes_supported).not.toContain("member:manage");
    expect(body.scopes_supported).not.toContain("apikey:manage");
  });

  it("tells an unauthenticated MCP caller where to authenticate", async () => {
    const res = await app().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
    );
  });
});

describe("registration", () => {
  it("registers a confidential client and returns its secret exactly once", async () => {
    const { status, body } = await registerClient();

    expect(status).toBe(201);
    expect(body.client_id).toMatch(/^sadhak-client-/);
    expect(body.client_secret).toBeTruthy();
  });

  it("registers a public client with no secret at all", async () => {
    const { body } = await registerClient({ token_endpoint_auth_method: "none" });

    expect(body.client_secret).toBeUndefined();
  });

  it("refuses a plaintext redirect_uri that is not loopback", async () => {
    // An authorization code travelling over http to somebody else's host is
    // the code being handed to whoever is on the wire.
    const { status, body } = await registerClient({
      redirect_uris: ["http://evil.example.com/cb"],
    });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("allows loopback over http, for a client running on someone's machine", async () => {
    const { status } = await registerClient({
      redirect_uris: ["http://127.0.0.1:8976/cb"],
    });

    expect(status).toBe(201);
  });
});

describe("authorize", () => {
  it("shows a consent screen naming the client and the capabilities", async () => {
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge } = pkce();

    const res = await app().request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, challenge))}`,
      { headers: { cookie } },
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Claude");
    expect(html).toContain("graph:read");
    expect(html).toContain("gate:invoke");
  });

  it("sends a signed-out visitor to sign in, and back to the same request", async () => {
    const { body: client } = await registerClient();
    const { challenge } = pkce();

    const res = await app().request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, challenge))}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/signin?next=");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "/oauth/authorize",
    );
  });

  it("refuses a redirect_uri the client never registered", async () => {
    // The one input an attacker most wants to influence, compared whole.
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge } = pkce();

    const params = authorizeParams(client.client_id, challenge);
    params.redirect_uri = "https://evil.example.com/cb";

    const res = await app().request(`/oauth/authorize?${new URLSearchParams(params)}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("caps the grant at what the person can actually do", async () => {
    // A viewer consenting to connector:manage does not create that power.
    const { cookie } = await seedPerson("viewer");
    const { body: client } = await registerClient();
    const { challenge, verifier } = pkce();

    const params = authorizeParams(
      client.client_id,
      challenge,
      "graph:read connector:manage",
    );
    const { code } = await consent(params, cookie);
    const { body } = await redeem({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });

    expect(body.scope).toBe("graph:read");
  });

  it("carries state back, and returns access_denied when the person says no", async () => {
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge } = pkce();

    const out = await consent(
      authorizeParams(client.client_id, challenge),
      cookie,
      "deny",
    );

    expect(out.status).toBe(302);
    expect(out.error).toBe("access_denied");
    expect(out.code).toBeNull();
    expect(new URL(out.location).searchParams.get("state")).toBe("opaque-state");
  });
});

describe("token", () => {
  it("exchanges a code for a token that the MCP route accepts", async () => {
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge, verifier } = pkce();

    const { code } = await consent(authorizeParams(client.client_id, challenge), cookie);
    const { status, body } = await redeem({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });

    expect(status).toBe(200);
    expect(body.token_type).toBe("Bearer");

    const mcp = await callMcp(body.access_token ?? "");
    expect(mcp.status).toBe(200);
  });

  it("refuses a verifier that does not match the challenge", async () => {
    // Without this the code alone is enough, which is the whole attack PKCE
    // exists to stop.
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge } = pkce();

    const { code } = await consent(authorizeParams(client.client_id, challenge), cookie);
    const { status, body } = await redeem({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: randomBytes(48).toString("base64url"),
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_grant");
  });

  it("treats a replayed code as a breach and kills what it issued", async () => {
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge, verifier } = pkce();

    const { code } = await consent(authorizeParams(client.client_id, challenge), cookie);
    const grant = {
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    };

    const first = await redeem(grant);
    expect(first.status).toBe(200);
    expect((await callMcp(first.body.access_token ?? "")).status).toBe(200);

    const second = await redeem(grant);
    expect(second.status).toBe(400);

    // The token from the first, legitimate-looking redemption is now dead too:
    // a code offered twice means it leaked, and only one of the two holders is
    // the real client.
    expect((await callMcp(first.body.access_token ?? "")).status).toBe(401);
  });

  it("refuses the wrong client secret", async () => {
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge, verifier } = pkce();

    const { code } = await consent(authorizeParams(client.client_id, challenge), cookie);
    const { status, body } = await redeem({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: "not-the-secret",
    });

    expect(status).toBe(401);
    expect(body.error).toBe("invalid_client");
  });

  it("rotates a refresh token and retires the one presented", async () => {
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge, verifier } = pkce();

    const { code } = await consent(authorizeParams(client.client_id, challenge), cookie);
    const first = await redeem({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });

    const refreshed = await redeem({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token ?? "",
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.body.refresh_token);

    const reused = await redeem({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token ?? "",
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });
    expect(reused.status).toBe(400);
  });
});

describe("revocation", () => {
  it("stops a token on the very next call", async () => {
    const { cookie } = await seedPerson();
    const { body: client } = await registerClient();
    const { challenge, verifier } = pkce();

    const { code } = await consent(authorizeParams(client.client_id, challenge), cookie);
    const { body } = await redeem({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    });

    expect((await callMcp(body.access_token ?? "")).status).toBe(200);

    await app().request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: body.access_token ?? "" }).toString(),
    });

    expect((await callMcp(body.access_token ?? "")).status).toBe(401);
  });

  it("answers 200 for a token it has never seen", async () => {
    // RFC 7009. Saying "no such token" would make this an oracle for guessing.
    const res = await app().request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "nothing-of-the-sort" }).toString(),
    });

    expect(res.status).toBe(200);
  });
});
