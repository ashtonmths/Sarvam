import { githubInstallations, miningScopes } from "@sadhak/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { githubAppConfigured, installationToken } from "../../github/app.js";
import type { LoopCtx } from "./execute.js";

/**
 * GitHub mining. The `repo:` qualifiers are appended by the tool from
 * `mining_scopes`, and a model-supplied `repo:` in the query is stripped — so
 * the model chooses the words and the server chooses the reach.
 */

/**
 * `authored_at` duplicates `date` under the name `propose_rationale` expects,
 * so the model copies a value rather than reformatting one.
 */
export interface GithubHit {
  title: string;
  snippet: string;
  author: string;
  date: string;
  authored_at: string | null;
  url: string;
}

/** Secondary rate limits: 1 search/sec per org, an independent ceiling. */
const lastSearchAt = new Map<number, number>();

async function throttle(orgId: number): Promise<void> {
  const last = lastSearchAt.get(orgId) ?? 0;
  const wait = 1000 - (Date.now() - last);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastSearchAt.set(orgId, Date.now());
}

/**
 * Falls back to the shared token so a deployment without the GitHub App can
 * still mine, which is the only reason that token exists. When both are absent
 * the caller reports it rather than returning an empty search.
 */
async function miningToken(orgId: number): Promise<string | null> {
  if (githubAppConfigured()) {
    const [row] = await db
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      .where(
        and(eq(githubInstallations.orgId, orgId), isNull(githubInstallations.removedAt)),
      )
      .limit(1);

    if (row) {
      try {
        return await installationToken(row.installationId);
      } catch {
        // A suspended or revoked installation falls through rather than
        // failing the search outright.
      }
    }
  }
  return config.GITHUB_TOKEN ?? null;
}

async function scopedRepos(orgId: number): Promise<string[]> {
  const rows = await db
    .select({ value: miningScopes.scopeValue })
    .from(miningScopes)
    .where(and(eq(miningScopes.orgId, orgId), eq(miningScopes.connector, "github")));
  return rows.map((r) => r.value);
}

/** Same contract as the Slack search: blocked is not the same as empty. */
export interface GithubSearchResult {
  hits: GithubHit[];
  unavailable?: string;
}

export async function searchGithub(
  ctx: LoopCtx,
  query: string,
  kind: "pr" | "commit" = "pr",
): Promise<GithubSearchResult> {
  const repos = await scopedRepos(ctx.orgId);
  if (repos.length === 0) {
    return {
      hits: [],
      unavailable:
        "No GitHub repository has been selected for mining, so there was nothing to search.",
    };
  }

  /**
   * The org's own installation first, the deployment token only as a fallback.
   *
   * Mining read every org's GitHub through one deployment-wide token, so reach
   * followed whoever owned that token rather than the customer's grant, and
   * every tenant competed for its single 30/min search budget. An installation
   * token is scoped to exactly the repositories that organisation installed
   * the app on, which is the same answer the change store already uses.
   */
  const token = await miningToken(ctx.orgId);
  if (!token) {
    return {
      hits: [],
      unavailable:
        "No GitHub credential is available for this organisation — install the Sadhak app on the repositories, or set GITHUB_TOKEN on the deployment. This is a configuration gap, not an absence of evidence.",
    };
  }

  await throttle(ctx.orgId);

  const scoped = [
    stripRepoQualifiers(query),
    ...repos.map((repo) => `repo:${repo}`),
    kind === "pr" ? "type:pr" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const endpoint =
    kind === "pr"
      ? `https://api.github.com/search/issues?q=${encodeURIComponent(scoped)}&per_page=10`
      : `https://api.github.com/search/commits?q=${encodeURIComponent(scoped)}&per_page=10`;

  const res = await fetch(endpoint, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) {
    return {
      hits: [],
      unavailable: `GitHub search returned HTTP ${res.status}${res.status === 403 ? " — likely a secondary rate limit" : ""}.`,
    };
  }

  const body = (await res.json()) as {
    items?: Array<{
      title?: string;
      body?: string;
      html_url?: string;
      created_at?: string;
      user?: { login?: string };
      commit?: { message?: string; author?: { name?: string; date?: string } };
    }>;
  };

  const hits = (body.items ?? [])
    .filter((item) => item.html_url)
    .slice(0, 10)
    .map((item) => ({
      title: item.title ?? item.commit?.message?.split("\n")[0] ?? "",
      snippet: (item.body ?? item.commit?.message ?? "").slice(0, 500),
      author: item.user?.login ?? item.commit?.author?.name ?? "unknown",
      date: item.created_at ?? item.commit?.author?.date ?? "",
      authored_at: item.created_at ?? item.commit?.author?.date ?? null,
      url: item.html_url as string,
    }));

  return { hits };
}

function stripRepoQualifiers(query: string): string {
  return query.replace(/\b(repo|org|user):\S+/gi, "").trim();
}
