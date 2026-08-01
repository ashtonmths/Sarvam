import { tokenForRepo } from "../changes/github-client.js";

/**
 * Pull requests that are open right now and touch the implicated files.
 *
 * This exists for one case, and it is the most valuable answer the diagnosis
 * can give: somebody already found the bug, already wrote the fix, and it is
 * sitting in review. Telling a team "merge #482 and this probably goes away"
 * is worth more than a correct root-cause essay, because the work is done and
 * only the merge is missing.
 *
 * Checked before the expensive path deliberately. If an open PR touches the
 * file that broke, there is no reason to spend a reasoning model working out
 * what the author of that PR already knows.
 */

const GITHUB_API = "https://api.github.com";

export interface OpenPr {
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string;
  /** Which of the implicated paths this PR touches. */
  matchedPaths: string[];
}

/** Enough to be worth reading, few enough to keep the API calls bounded. */
const MAX_PRS_SCANNED = 20;
const MAX_RETURNED = 3;

async function gh<T>(url: string, token: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  return res.ok ? ((await res.json()) as T) : null;
}

/**
 * Returns open PRs whose changed files intersect `paths`.
 *
 * Matching is by suffix rather than equality: the graph stores a table or a
 * workflow, and what implicates it is `apps/api/src/billing/invoices.ts` — the
 * caller passes whatever fragments it has, and a PR touching a longer path that
 * ends in one of them is a match.
 *
 * Returns an empty array rather than throwing on any GitHub problem. This is a
 * bonus lookup on top of a diagnosis that is already useful; a rate limit here
 * must not lose the rest of the report.
 */
export async function openPrsTouching(
  owner: string,
  name: string,
  installationId: number | null,
  paths: string[],
): Promise<OpenPr[]> {
  if (paths.length === 0) return [];

  let token: string;
  try {
    token = await tokenForRepo({ owner, name, installationId } as Parameters<
      typeof tokenForRepo
    >[0]);
  } catch {
    return [];
  }

  const list = await gh<Array<{ number: number }>>(
    `${GITHUB_API}/repos/${owner}/${name}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_PRS_SCANNED}`,
    token,
  );
  if (!list || list.length === 0) return [];

  const found: OpenPr[] = [];

  for (const { number } of list) {
    if (found.length >= MAX_RETURNED) break;

    // One request per PR for its file list. Bounded by MAX_PRS_SCANNED, and it
    // stops as soon as enough matches are found, so the common case — no open
    // PR touches this — costs the scan and the common case with a match costs
    // less.
    const files = await gh<Array<{ filename: string }>>(
      `${GITHUB_API}/repos/${owner}/${name}/pulls/${number}/files?per_page=100`,
      token,
    );
    if (!files) continue;

    const matched = paths.filter((path) =>
      files.some((file) => file.filename === path || file.filename.endsWith(`/${path}`)),
    );
    if (matched.length === 0) continue;

    const detail = await gh<{
      number: number;
      title: string;
      html_url: string;
      user?: { login?: string };
      updated_at: string;
    }>(`${GITHUB_API}/repos/${owner}/${name}/pulls/${number}`, token);
    if (!detail) continue;

    found.push({
      number: detail.number,
      title: detail.title,
      url: detail.html_url,
      author: detail.user?.login ?? null,
      updatedAt: detail.updated_at,
      matchedPaths: matched,
    });
  }

  return found;
}
