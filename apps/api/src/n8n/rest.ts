import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { UpstreamError } from "../errors.js";
import type { EgressOptions } from "../net/guard.js";
import { pinnedFetch } from "../net/pinned-fetch.js";

/**
 * n8n's *internal* `/rest` API — the endpoints its editor UI calls.
 *
 * Everything in this file is unversioned and carries no compatibility promise
 * from n8n. That is a real cost and it is taken deliberately, because the
 * alternative is worse for the person signing up:
 *
 * The public API can create a user but cannot give it a password. It returns
 * an invite link instead, and with SMTP unconfigured nothing delivers it. Worse,
 * an account whose password the user chooses is an account we can never mint an
 * API key for — minting requires that user's session — so the connector would
 * sit unauthenticated until they pasted a key by hand. A shared owner key is
 * not a substitute: workflow objects carry no ownership field and
 * `/api/v1/projects` is licence-gated, so one key cannot be narrowed to one
 * tenant.
 *
 * So signup completes the invite itself with a generated password, signs in as
 * the new user, and mints *their* key — which n8n does scope to their own
 * workflows. Verified: the owner key lists every workflow on the instance, a
 * freshly minted user key lists none of them.
 *
 * The blast radius of an n8n upgrade breaking this is one job, `n8n.provision_
 * account`, which already records its failure and retries. Reading workflows
 * and executions still goes exclusively through the public `/api/v1` surface.
 */

const EGRESS: EgressOptions = { allowHttp: true };

function restUrl(path: string): URL {
  if (!config.N8N_BASE_URL) {
    throw new UpstreamError("N8N_BASE_URL is not configured");
  }
  return new URL(path, `${config.N8N_BASE_URL.replace(/\/+$/, "")}/`);
}

/**
 * n8n's auth cookie, read from the response.
 *
 * `getSetCookie()` rather than `get("set-cookie")`: a single joined header
 * loses the boundaries between cookies, and n8n sets more than one. Only the
 * name=value pair is kept — the attributes are instructions for a browser.
 */
function authCookieFrom(response: Response): string | null {
  const entries = response.headers.getSetCookie?.() ?? [];
  for (const entry of entries) {
    const match = /(^|;\s*)(n8n-auth=[^;]+)/.exec(entry);
    if (match?.[2]) return match[2];
  }
  return null;
}

async function restPost(
  path: string,
  body: unknown,
  cookie?: string,
  signal?: AbortSignal,
): Promise<{ response: Response; json: unknown }> {
  const response = await pinnedFetch(
    restUrl(path).toString(),
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(signal ? { signal } : {}),
    },
    EGRESS,
  );

  const text = await response.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { response, json };
}

/**
 * A password that satisfies n8n's rule: 8–64 characters, at least one digit
 * and at least one uppercase letter.
 *
 * Base64url of 18 random bytes carries 144 bits, but says nothing about
 * containing a digit or a capital — an alphabet can legitimately produce
 * neither. The fixed suffix guarantees both rather than looping until the
 * random draw happens to comply.
 */
export function generateN8nPassword(): string {
  return `${randomBytes(18).toString("base64url")}A7`;
}

export interface AcceptedInvite {
  cookie: string;
}

/**
 * Completes an invite, setting the password.
 *
 * Single-use by nature: once accepted, the link in `inviteAcceptUrl` is spent
 * and this call fails for that invitee. That is why provisioning treats an
 * already-accepted account as a terminal state rather than retrying into it.
 */
export async function acceptN8nInvite(input: {
  inviteeId: string;
  inviterId: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  signal?: AbortSignal;
}): Promise<AcceptedInvite> {
  const { response, json } = await restPost(
    `rest/invitations/${encodeURIComponent(input.inviteeId)}/accept`,
    {
      inviterId: input.inviterId,
      firstName: input.firstName,
      lastName: input.lastName,
      password: input.password,
    },
    undefined,
    input.signal,
  );

  if (!response.ok) {
    throw new UpstreamError(
      `n8n invite accept failed: ${response.status} ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  const cookie = authCookieFrom(response);
  if (cookie) return { cookie };

  // Accepting normally signs the user in. If it did not, the password is still
  // set, so a plain sign-in gets us the session the key mint needs.
  return { cookie: await signInToN8n(input.email, input.password, input.signal) };
}

export async function signInToN8n(
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<string> {
  const { response, json } = await restPost(
    "rest/login",
    { email, password },
    undefined,
    signal,
  );

  if (!response.ok) {
    throw new UpstreamError(
      `n8n sign-in failed for ${email}: ${response.status} ${JSON.stringify(json).slice(0, 160)}`,
    );
  }

  const cookie = authCookieFrom(response);
  if (!cookie) throw new UpstreamError("n8n sign-in returned no auth cookie");
  return cookie;
}

/**
 * Mints an API key for whoever the cookie belongs to.
 *
 * The plaintext is returned exactly once, here. `GET /rest/api-keys` redacts
 * it forever after, so a key not captured from this response is a key that has
 * to be revoked and replaced.
 */
export async function mintApiKeyAs(
  cookie: string,
  signal?: AbortSignal,
): Promise<string> {
  const { response, json } = await restPost("rest/api-keys", {}, cookie, signal);

  if (!response.ok) {
    throw new UpstreamError(
      `n8n api key mint failed: ${response.status} ${JSON.stringify(json).slice(0, 160)}`,
    );
  }

  const key = (json as { data?: { apiKey?: string } })?.data?.apiKey;
  if (!key) throw new UpstreamError("n8n returned no api key");
  return key;
}
