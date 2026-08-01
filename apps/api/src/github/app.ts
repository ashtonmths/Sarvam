import { createSign } from "node:crypto";
import { config, requireEnv } from "../config.js";
import { verifyHmacSha256 } from "../crypto/compare.js";
import { UpstreamError, UserError } from "../errors.js";

/**
 * A PAT is a person; an App is a product.
 *
 * Per-org installation, fine-grained permissions and short-lived tokens are
 * what a security reviewer expects to find. The App's private key is a
 * *platform* secret — it lives in the environment, never in the per-org vault,
 * which holds only the installation id alongside customer credentials.
 *
 * The JWT is signed here with node:crypto rather than pulling in an auth
 * library: RS256 over three JSON segments is twenty lines, and this keeps the
 * dependency surface of a credential-signing path at zero.
 */

const GITHUB_API = "https://api.github.com";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** App JWTs are short-lived by GitHub's rule: 10 minutes maximum. */
export function appJwt(): string {
  const appId = requireEnv("GITHUB_APP_ID");
  const privateKey = requireEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      // 60s back-dated to tolerate clock skew against GitHub.
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString("base64url");

  return `${header}.${payload}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** In memory only, never persisted — the tokens live an hour. */
const tokenCache = new Map<number, CachedToken>();

export async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  // Refresh a minute early rather than racing the expiry.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    throw new UpstreamError(
      `GitHub refused an installation token (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: new Date(body.expires_at).getTime(),
  });
  return body.token;
}

export function githubAppConfigured(): boolean {
  return Boolean(
    config.GITHUB_APP_ID &&
      config.GITHUB_APP_PRIVATE_KEY &&
      config.GITHUB_APP_WEBHOOK_SECRET,
  );
}

/**
 * Verified **before** parsing, over the exact raw bytes GitHub sent. Parsing
 * first would mean acting on an unverified payload, and a webhook route is a
 * remote instruction to run our machinery.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const secret = config.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) return false;

  return verifyHmacSha256({
    rawBody,
    key: secret,
    presented: signature,
    prefix: "sha256=",
  });
}

/* ------------------------------------------------------------ REST calls */

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw new UpstreamError(
      `GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

export interface ChangedFile {
  filename: string;
  status: string;
  /** Absent for binary files and very large diffs. */
  patch?: string;
}

/** Capped: a giant PR overflows to `unknowns` rather than a retry storm. */
export const MAX_CHANGED_FILES = 100;

export async function listChangedFiles(
  token: string,
  repo: string,
  prNumber: number,
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const files = await gh<ChangedFile[]>(
    token,
    `/repos/${repo}/pulls/${prNumber}/files?per_page=${MAX_CHANGED_FILES}`,
  );
  return { files, truncated: files.length >= MAX_CHANGED_FILES };
}

export async function getFileContent(
  token: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const body = await gh<{ content?: string; encoding?: string }>(
      token,
      `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!body.content) return null;
    return Buffer.from(
      body.content,
      body.encoding === "base64" ? "base64" : "utf8",
    ).toString("utf8");
  } catch {
    // A file that does not exist at this ref is a deletion, not an error.
    return null;
  }
}

export interface CheckRunOutput {
  title: string;
  summary: string;
}

export async function createCheckRun(
  token: string,
  repo: string,
  headSha: string,
): Promise<number> {
  const body = await gh<{ id: number }>(token, `/repos/${repo}/check-runs`, {
    method: "POST",
    body: JSON.stringify({
      name: "sadhak/gate",
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    }),
  });
  return body.id;
}

export async function completeCheckRun(
  token: string,
  repo: string,
  checkRunId: number,
  conclusion: "success" | "failure" | "neutral",
  output: CheckRunOutput,
): Promise<void> {
  await gh(token, `/repos/${repo}/check-runs/${checkRunId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: { title: output.title, summary: output.summary.slice(0, 65_000) },
    }),
  });
}

/**
 * Whether the repo actually requires our check. Without it the gate is
 * advisory, and a customer believing otherwise is worse than no gate — the
 * web app surfaces this as "installed but not enforcing".
 */
/**
 * The repositories an installation actually covers.
 *
 * Needed because the installation row records only the *account* it was
 * installed on, and enforcement is a per-repository, per-branch setting. The
 * default branch comes back on the same response, which matters: asking about
 * protection on `main` for a repo whose default is `master` reports "not
 * enforcing" for a repository that is correctly protected.
 */
export async function installationRepositories(
  token: string,
): Promise<Array<{ fullName: string; defaultBranch: string }>> {
  try {
    const body = await gh<{
      repositories?: Array<{ full_name?: string; default_branch?: string }>;
    }>(token, "/installation/repos?per_page=100");

    return (body.repositories ?? [])
      .filter((repo) => repo.full_name)
      .map((repo) => ({
        fullName: repo.full_name as string,
        defaultBranch: repo.default_branch || "main",
      }));
  } catch {
    // An unreadable installation reports nothing rather than guessing, so the
    // caller renders "unknown" instead of a confident "not enforcing".
    return [];
  }
}

export async function isCheckRequired(
  token: string,
  repo: string,
  branch = "main",
): Promise<boolean | null> {
  try {
    const body = await gh<{ contexts?: string[]; checks?: Array<{ context: string }> }>(
      token,
      `/repos/${repo}/branches/${branch}/protection/required_status_checks`,
    );
    const contexts = [
      ...(body.contexts ?? []),
      ...(body.checks ?? []).map((c) => c.context),
    ];
    return contexts.includes("sadhak/gate");
  } catch {
    // 404 means no protection configured at all — a definite "not enforcing".
    return false;
  }
}

export function assertAppConfigured(): void {
  if (!githubAppConfigured()) {
    throw new UserError(
      "The GitHub App is not configured — set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_WEBHOOK_SECRET",
      { status: 503, type: "not-configured" },
    );
  }
}
