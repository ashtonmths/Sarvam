import { INTEGRATION_CAPABILITIES } from "@sadhak/shared/rbac";
import { Hono } from "hono";
import { config } from "../config.js";

/**
 * The two documents a client reads before it ever tries to authenticate.
 *
 * MCP's authorization spec builds on OAuth's discovery RFCs rather than
 * inventing its own handshake: the client gets a 401 carrying
 * `WWW-Authenticate: Bearer resource_metadata="…"`, fetches that document to
 * learn which authorization server guards this resource, then fetches the
 * server's own metadata to learn where to send the user and where to redeem
 * the code. Both are unauthenticated by design — they are a signpost, and a
 * signpost you must already be inside to read is not one.
 *
 * The issuer has to be a stable absolute URL rather than something derived
 * from the request, because it is compared byte for byte by the client and
 * appears inside tokens. `PUBLIC_API_URL` is the same value the Slack callback
 * already relies on for the same reason; deriving it from the Host header
 * would let a caller that controls that header move the issuer.
 */

export const oauthMetadataRoutes = new Hono();

/** The API's own public address, which is the OAuth issuer and the resource. */
export function issuer(): string {
  const url = config.PUBLIC_API_URL;
  if (!url) {
    // Not a crash: the rest of the API is perfectly usable without OAuth, and
    // a self-hoster who never adds a connector should not be forced to set
    // this. The endpoints below are what fail, and they say why.
    throw new Error("PUBLIC_API_URL must be set to serve OAuth metadata");
  }
  return url.replace(/\/$/, "");
}

/**
 * RFC 9728. Names the resource and points at whoever can issue tokens for it —
 * here the same origin, since Sadhak is its own authorization server.
 */
oauthMetadataRoutes.get("/.well-known/oauth-protected-resource", (c) => {
  const base = issuer();
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [...INTEGRATION_CAPABILITIES],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://sadhak.online/docs/mcp",
  });
});

/**
 * RFC 8414. `code` with PKCE only — no implicit grant, which hands a token to
 * a redirect URI and cannot be bound to a verifier, and no password grant,
 * which asks a client to handle a password it should never see.
 */
oauthMetadataRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  const base = issuer();
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...INTEGRATION_CAPABILITIES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 alone. `plain` is in the RFC for clients that cannot hash, and
    // accepting it would let any client that can see the request replay it.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  });
});
