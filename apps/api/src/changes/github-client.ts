import type { Repository } from "@sadhak/shared/schema";
import { config } from "../config.js";
import { UpstreamError, UserError } from "../errors.js";
import { githubAppConfigured, installationToken } from "../github/app.js";
import type { EgressOptions } from "../net/guard.js";
import { pinnedFetch } from "../net/pinned-fetch.js";

/**
 * The GitHub reads the change store needs, and nothing else.
 *
 * Deliberately not an `InstanceHttp`: that class is GET-only against one fixed
 * base URL with a per-instance token, and the change store authenticates per
 * *repository* with a token that expires hourly. It still goes through
 * `pinnedFetch`, so the egress guard and the redirect refusal apply the same
 * way they do to a crawl.
 */

const GITHUB_API = "https://api.github.com";

/** api.github.com is a fixed public vendor host, so nothing private is allowed. */
const EGRESS: EgressOptions = { allowPrivateHosts: [] };

export interface RawChange {
  kind: "commit" | "pull_request";
  externalId: string;
  title: string;
  body: string | null;
  authorLogin: string | null;
  authorEmail: string | null;
  occurredAt: Date;
  url: string;
}

export interface ChangePage {
  changes: RawChange[];
  /** False when GitHub returned a short page, meaning history is exhausted. */
  hasMore: boolean;
}

/**
 * The org's installation token where the App is set up, and the deployment
 * token otherwise.
 *
 * The installation token is the correct answer: it is scoped to exactly the
 * repositories that organisation installed the App on, so reach follows the
 * customer's grant. The fallback exists because a deployment with no App
 * configured would otherwise be unable to read anything at all, and a feature
 * that needs an afternoon of GitHub App setup before it does anything once is
 * a feature nobody evaluates.
 */
export async function tokenForRepo(repo: Repository): Promise<string> {
  if (repo.installationId !== null && githubAppConfigured()) {
    return installationToken(repo.installationId);
  }
  if (config.GITHUB_TOKEN) return config.GITHUB_TOKEN;

  throw new UserError(
    `No GitHub credential can read ${repo.owner}/${repo.name}. Install the Sadhak GitHub App on it, or set GITHUB_TOKEN on the deployment.`,
    { status: 422 },
  );
}

/**
 * Proves the caller may read a repository before anything is stored under
 * their organisation.
 *
 * Without this, tracking is self-service over whatever the *deployment's*
 * token can see: on a shared deployment one tenant could name another's
 * private repository and have its commit messages, author emails and file
 * paths backfilled into rows tagged with their own org id. Every query
 * downstream is correctly org-scoped — to the wrong org, because entitlement
 * was never established.
 *
 * An installation token is self-limiting, so the check is a formality there.
 * The shared token is not limited by anything, which is exactly why the repo
 * has to be named by an installation this org owns before it is used.
 */
export async function assertReadable(input: {
  owner: string;
  name: string;
  installationId: number | null;
  /**
   * Whether this deployment serves exactly one organisation. The shared token
   * is only acceptable then, because there is no second tenant for its reach
   * to leak into.
   */
  singleTenant: boolean;
}): Promise<void> {
  const { owner, name, installationId } = input;

  if (installationId !== null && githubAppConfigured()) {
    const token = await installationToken(installationId);
    const response = await pinnedFetch(
      `${GITHUB_API}/repos/${owner}/${name}`,
      { headers: headers(token) },
      EGRESS,
    );
    if (response.ok) return;
    throw new UserError(
      `The Sadhak GitHub App installation for this organisation cannot read ${owner}/${name}. Add the repository to the installation on GitHub, then track it again.`,
      { status: 403 },
    );
  }

  /**
   * The shared token proves the *deployment* can read a repository, never that
   * this organisation may. On a shared deployment that difference is the whole
   * hole: one tenant naming another's private repository would have its commit
   * messages, author emails and file paths backfilled into rows tagged with
   * the first tenant's org id, and every query downstream would serve them
   * back perfectly correctly scoped to the wrong org.
   *
   * With one organisation there is no second tenant to leak into, so the same
   * token is fine and a single-org deployment stays evaluable without setting
   * up a GitHub App first.
   */
  if (input.singleTenant && config.GITHUB_TOKEN) return;

  throw new UserError(
    `${owner}/${name} is not covered by a GitHub App installation linked to this organisation. Install the Sadhak app on it — on a deployment serving more than one organisation, the shared token is not proof that this one may read it.`,
    { status: 403 },
  );
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

/**
 * A rate-limited or failing GitHub is reported, never swallowed.
 *
 * The mining tools return `[]` on any failure, which the agent cannot tell
 * apart from "there was nothing to find" — it gives up having spent its
 * budget, and records the edge as unexplainable. A backfill is a job, so it
 * can afford to throw and be retried, and that is strictly more honest.
 */
/**
 * Exported so every GitHub read goes through the same door.
 *
 * The egress guard, DNS pinning and rate-limit handling all live here. A
 * caller that reimplements the request with bare `fetch` loses all three, and
 * loses them silently — a 403 from a rate limit becomes an empty result rather
 * than a retry, which is indistinguishable from "there was nothing to find".
 */
export async function getJson<T>(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await pinnedFetch(
    url,
    { headers: headers(token), ...(signal ? { signal } : {}) },
    EGRESS,
  );

  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get("x-ratelimit-reset");
    throw new UpstreamError(
      `GitHub rate limit reached${reset ? `, resets at ${new Date(Number(reset) * 1000).toISOString()}` : ""}`,
    );
  }
  if (!response.ok) {
    throw new UpstreamError(
      `GitHub ${response.status} for ${new URL(url).pathname}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

interface CommitItem {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { login?: string } | null;
}

/**
 * When a commit landed on the branch — committer date, not author date.
 *
 * The two diverge constantly: rebase, cherry-pick and squash-merge all keep
 * the author date and rewrite the committer date. Two things depend on
 * getting this right, and both break the same way.
 *
 * GitHub filters `since`/`until` on *committer* date and returns commits in
 * that order, so paging with a bound computed from author dates walks off the
 * ordering the API is using — one rebased-in commit authored two years ago
 * drags the cursor two years back and every commit in between is skipped.
 *
 * And the investigation asks "what shipped between the checkpoint and the
 * incident". A commit authored three weeks ago and merged forty minutes before
 * the outage shipped forty minutes ago. Filing it under the authoring date
 * hides it from the exact window that exists to find it.
 *
 * Author date is kept as the fallback because it is always present, while
 * committer date is theoretically omittable.
 */
function landedAt(item: CommitItem): Date | null {
  const raw = item.commit.committer?.date ?? item.commit.author?.date;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Commits on the default branch, newest first.
 *
 * `until` walks backwards a page at a time, which is what makes the caller
 * resumable: the cursor it commits after each page is simply the oldest
 * instant reached so far.
 */
export async function fetchCommits(
  repo: Repository,
  token: string,
  window: { since?: Date; until?: Date },
  perPage = 100,
  signal?: AbortSignal,
): Promise<ChangePage> {
  const params = new URLSearchParams({
    sha: repo.defaultBranch,
    per_page: String(perPage),
  });
  if (window.since) params.set("since", window.since.toISOString());
  if (window.until) params.set("until", window.until.toISOString());

  const items = await getJson<CommitItem[]>(
    `${GITHUB_API}/repos/${repo.owner}/${repo.name}/commits?${params}`,
    token,
    signal,
  );

  const changes = items
    .map((item): RawChange | null => {
      const at = landedAt(item);
      // A commit with no usable date cannot be placed on the timeline, and a
      // change with no time is useless to a window query — so it is dropped
      // rather than dated `now` and silently misfiled.
      if (!at) return null;
      const [title, ...rest] = item.commit.message.split("\n");
      return {
        kind: "commit",
        externalId: item.sha,
        title: (title ?? item.sha.slice(0, 7)).slice(0, 500),
        body: rest.join("\n").trim() || null,
        authorLogin: item.author?.login ?? null,
        authorEmail: item.commit.author?.email ?? null,
        occurredAt: at,
        url: item.html_url,
      };
    })
    .filter((c): c is RawChange => c !== null);

  return { changes, hasMore: items.length === perPage };
}

interface PullItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  created_at: string;
  user?: { login?: string } | null;
}

/**
 * Pull requests, ordered by update so a paged walk is stable.
 *
 * Dated by merge where merged and by creation otherwise: an unmerged PR is
 * still a written statement of intent worth citing, but it did not change
 * anything at its creation time, so treating the two identically would put
 * proposals into a window alongside the changes that actually shipped.
 */
export async function fetchPulls(
  repo: Repository,
  token: string,
  page = 1,
  perPage = 100,
  signal?: AbortSignal,
): Promise<ChangePage> {
  const params = new URLSearchParams({
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: String(perPage),
    page: String(page),
  });

  const items = await getJson<PullItem[]>(
    `${GITHUB_API}/repos/${repo.owner}/${repo.name}/pulls?${params}`,
    token,
    signal,
  );

  const changes = items.map(
    (item): RawChange => ({
      kind: "pull_request",
      externalId: String(item.number),
      title: item.title.slice(0, 500),
      body: item.body,
      authorLogin: item.user?.login ?? null,
      authorEmail: null,
      occurredAt: new Date(item.merged_at ?? item.created_at),
      url: item.html_url,
    }),
  );

  return { changes, hasMore: items.length === perPage };
}

export interface TouchedPath {
  path: string;
  status: string;
}

/**
 * The files one change touched, capped.
 *
 * A generated-lockfile commit can touch thousands, and the paths exist to
 * judge relevance rather than to reproduce the tree — past a point they stop
 * discriminating and start costing rows. GitHub itself truncates this list at
 * 300 files, so the cap acknowledges a limit that already exists.
 */
export const MAX_PATHS_PER_CHANGE = 300;

export async function fetchPaths(
  repo: Repository,
  token: string,
  change: { kind: "commit" | "pull_request"; externalId: string },
  signal?: AbortSignal,
): Promise<TouchedPath[]> {
  const base = `${GITHUB_API}/repos/${repo.owner}/${repo.name}`;

  if (change.kind === "commit") {
    const detail = await getJson<{ files?: Array<{ filename: string; status: string }> }>(
      `${base}/commits/${change.externalId}`,
      token,
      signal,
    );
    return (detail.files ?? []).slice(0, MAX_PATHS_PER_CHANGE).map((file) => ({
      path: file.filename,
      status: file.status,
    }));
  }

  const files = await getJson<Array<{ filename: string; status: string }>>(
    `${base}/pulls/${change.externalId}/files?per_page=${MAX_PATHS_PER_CHANGE}`,
    token,
    signal,
  );
  return files.slice(0, MAX_PATHS_PER_CHANGE).map((file) => ({
    path: file.filename,
    status: file.status,
  }));
}
