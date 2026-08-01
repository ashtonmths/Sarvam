import { miningScopes } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db.js";
import type { LoopCtx } from "./execute.js";

/**
 * GitHub mining. The `repo:` qualifiers are appended by the tool from
 * `mining_scopes`, and a model-supplied `repo:` in the query is stripped — so
 * the model chooses the words and the server chooses the reach.
 */

export interface GithubHit {
  title: string;
  snippet: string;
  author: string;
  date: string;
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

async function scopedRepos(orgId: number): Promise<string[]> {
  const rows = await db
    .select({ value: miningScopes.scopeValue })
    .from(miningScopes)
    .where(and(eq(miningScopes.orgId, orgId), eq(miningScopes.connector, "github")));
  return rows.map((r) => r.value);
}

export async function searchGithub(
  ctx: LoopCtx,
  query: string,
  kind: "pr" | "commit" = "pr",
): Promise<GithubHit[]> {
  const repos = await scopedRepos(ctx.orgId);
  if (repos.length === 0) return [];

  const token = config.GITHUB_TOKEN;
  if (!token) return [];

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
  if (!res.ok) return [];

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

  return (body.items ?? [])
    .filter((item) => item.html_url)
    .slice(0, 10)
    .map((item) => ({
      title: item.title ?? item.commit?.message?.split("\n")[0] ?? "",
      snippet: (item.body ?? item.commit?.message ?? "").slice(0, 500),
      author: item.user?.login ?? item.commit?.author?.name ?? "unknown",
      date: item.created_at ?? item.commit?.author?.date ?? "",
      url: item.html_url as string,
    }));
}

function stripRepoQualifiers(query: string): string {
  return query.replace(/\b(repo|org|user):\S+/gi, "").trim();
}
