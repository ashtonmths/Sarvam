import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Gets the local n8n to the point where Sadhak can provision accounts on it.
 *
 * There is no public-API path to a first API key: `POST /api/v1/users` needs a
 * key, and the only way to mint one is as a signed-in owner. So this drives
 * n8n's *internal* `/rest` endpoints — the ones the editor UI calls — to do
 * what a human would otherwise do by hand: create the owner, sign in, mint a
 * key, and write it into `.env`.
 *
 * Those endpoints are unversioned and carry no compatibility promise, which is
 * the trade being made here. It is acceptable because this is a local
 * development convenience and nothing in the running application depends on
 * it: the API talks to n8n exclusively through the public `/api/v1` surface.
 * If an n8n upgrade breaks this script, the fallback is the Settings → API
 * screen and a copy-paste, and the product is unaffected.
 *
 *   pnpm n8n:bootstrap
 *
 * Idempotent. A second run signs in instead of setting up, and mints an
 * additional key only because n8n will not reveal an existing one twice.
 */

const BASE_URL = process.env.N8N_BASE_URL_LOCAL ?? "http://localhost:5678";
const EMAIL = process.env.N8N_OWNER_EMAIL ?? "demo@sadhak.online";
/** n8n requires 8–64 chars with at least one number and one uppercase. */
const PASSWORD = process.env.N8N_OWNER_PASSWORD ?? "Sadhak-demo-2026";

const root = new URL("..", import.meta.url);
const envPath = fileURLToPath(new URL(".env", root));

interface Settings {
  data?: { userManagement?: { showSetupOnFirstLoad?: boolean } };
}

/**
 * n8n's auth cookie, taken from the response rather than a cookie jar.
 *
 * `set-cookie` is the only place it appears, and undici exposes multiple
 * headers through `getSetCookie()`. Parsing just the name=value pair is enough
 * — the attributes are for a browser, and this is not one.
 */
function authCookieFrom(response: Response): string | null {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const match = /(^|;\s*)(n8n-auth=[^;]+)/.exec(entry);
    if (match?.[2]) return match[2];
  }
  return null;
}

async function post(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ response: Response; json: unknown }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { response, json };
}

async function isFreshInstance(): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/rest/settings`);
  if (!response.ok) {
    throw new Error(
      `n8n is not answering on ${BASE_URL} (${response.status}). Is the stack up?`,
    );
  }
  const settings = (await response.json()) as Settings;
  return settings.data?.userManagement?.showSetupOnFirstLoad === true;
}

/**
 * Upserts one key, preserving everything else in the file.
 *
 * Rewriting `.env` wholesale would discard the credential master key and the
 * session secret, which are not recoverable — losing CREDENTIAL_MASTER_KEY
 * makes every stored connector credential permanently unreadable.
 */
function writeEnvVar(key: string, value: string): void {
  let contents = "";
  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    contents = "";
  }

  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(contents)) {
    contents = contents.replace(pattern, line);
  } else {
    contents = `${contents.replace(/\n*$/, "\n")}${line}\n`;
  }

  writeFileSync(envPath, contents, "utf8");
}

/**
 * Clears the owner's existing API keys so a fresh one can be minted.
 *
 * Not gratuitous. n8n 1.75 permits exactly one key per user and names it "My
 * API Key" regardless of what the request asks for, so a second create fails
 * with a duplicate-name 500. Reusing the existing one is not an option either:
 * `GET /rest/api-keys` returns it redacted, and the plaintext is shown exactly
 * once, at creation.
 *
 * So a re-run necessarily rotates. Anything else still holding the old key
 * stops working — which for a local bootstrap is only ever this stack's own
 * `.env`, rewritten a few lines below.
 */
async function revokeExistingKeys(cookie: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/rest/api-keys`, { headers: { cookie } });
  if (!response.ok) return;

  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  for (const key of body.data ?? []) {
    if (!key.id) continue;
    await fetch(`${BASE_URL}/rest/api-keys/${key.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    console.log(`revoked previous n8n API key ${key.id}`);
  }
}

async function main(): Promise<void> {
  const fresh = await isFreshInstance();

  let cookie: string | null;

  if (fresh) {
    const { response, json } = await post("/rest/owner/setup", {
      email: EMAIL,
      firstName: "Sadhak",
      lastName: "Owner",
      password: PASSWORD,
    });
    if (!response.ok) {
      throw new Error(`owner setup failed: ${response.status} ${JSON.stringify(json)}`);
    }
    cookie = authCookieFrom(response);
    console.log(`n8n owner created: ${EMAIL}`);
  } else {
    const { response, json } = await post("/rest/login", {
      email: EMAIL,
      password: PASSWORD,
    });
    if (!response.ok) {
      throw new Error(
        `owner already exists but sign-in failed: ${response.status} ${JSON.stringify(json)}.\n` +
          "Set N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD to the real credentials, or mint a\n" +
          "key by hand from n8n's Settings → API screen and put it in .env.",
      );
    }
    cookie = authCookieFrom(response);
    console.log(`n8n owner already set up, signed in as ${EMAIL}`);
  }

  if (!cookie) throw new Error("n8n did not return an auth cookie");

  await revokeExistingKeys(cookie);

  const { response, json } = await post("/rest/api-keys", {}, cookie);
  if (!response.ok) {
    throw new Error(
      `api key creation failed: ${response.status} ${JSON.stringify(json)}`,
    );
  }

  const apiKey = (json as { data?: { apiKey?: string } })?.data?.apiKey;
  if (!apiKey) throw new Error(`api key missing from response: ${JSON.stringify(json)}`);

  writeEnvVar("N8N_API_KEY", apiKey);
  console.log(`N8N_API_KEY written to .env (${apiKey.slice(0, 12)}…)`);
  console.log(
    "\nRestart the api container so it picks the key up:\n" +
      "  docker compose -f docker-compose.yml -f docker-compose.app.yml up -d api",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
