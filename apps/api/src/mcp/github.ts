import type { Repository } from "@sadhak/shared/schema";
import { ciFailures, repositories as reposTable } from "@sadhak/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getJson, tokenForRepo } from "../changes/github-client.js";
import { findRepository, listRepositories } from "../changes/store.js";
import { db } from "../db.js";
import { UserError } from "../errors.js";
import type { McpContext } from "./tools.js";

/**
 * What is going on in this organisation's GitHub, for an agent that has to
 * answer for it.
 *
 * One tool rather than nine. The questions here — what shipped, what broke,
 * what is waiting for review — are asked together far more often than
 * separately, and nine sibling tools would spend nine slots of a model's tool
 * budget to express one subject. `action` is the discriminator, and every
 * action returns the same envelope so a caller learns the shape once.
 *
 * Authentication is the GitHub App's per-repository installation token, reached
 * through `tokenForRepo` — the same path the change store uses. That matters
 * beyond tidiness: an installation token is scoped to exactly the repositories
 * the customer installed the App on, so this tool's reach is the customer's
 * grant rather than whatever the deployment's own credential happens to see.
 * Reads go through `getJson`, which routes via `pinnedFetch` and so keeps the
 * egress guard, the redirect refusal and the rate-limit translation that a bare
 * `fetch` would silently drop.
 *
 * Deployments and workflow runs are read live. Commits, pull requests and
 * analysed CI failures also exist locally in the change store, but the local
 * copy is only as fresh as the last webhook, and "did it deploy" is exactly the
 * question where a stale answer is a wrong answer. The one place the local copy
 * wins outright is `ci_failures`, which carries a model's root-cause analysis
 * that GitHub does not have.
 */

const GITHUB_API = "https://api.github.com";

/**
 * How many repositories one call may fan out across.
 *
 * An org with forty tracked repositories asking "any deployment failures?"
 * would otherwise spend forty round trips inside a single tool call. The cap is
 * announced in `notes` rather than applied quietly — a silently truncated sweep
 * reads exactly like a clean bill of health.
 */
const MAX_REPOS = 5;

/** Deployment statuses cost a request each, so the scan is bounded. */
const DEPLOYMENT_SCAN = 20;

export const githubActivityInput = z.object({
  action: z
    .enum([
      "summary",
      "repos",
      "last_commit",
      "commits",
      "pull_requests",
      "deployments",
      "deployment_failures",
      "ci_failures",
      "checks",
    ])
    .describe(
      "What to look up. " +
        'summary — one call for the whole picture per repo: last commit, open pull requests, latest deployment per environment, recent failures. Start here when the question is vague ("how are things?", "anything broken?"). ' +
        "repos — which repositories this organisation has connected, and how much history exists for each. " +
        "last_commit — the newest commit on a branch, with the CI checks that ran against it. " +
        "commits — recent commits on a branch. " +
        "pull_requests — recent pull requests, filtered by state. " +
        "deployments — recent deployments with the current state of each. " +
        'deployment_failures — failed deployments and failed workflow runs together: the answer to "what is broken". ' +
        "ci_failures — failures this deployment already captured and had a model analyse, with cause and recommendation. Richer than GitHub's own view, but only covers default-branch failures since the App was installed. " +
        "checks — the check runs for one commit or branch tip.",
    ),
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'Use "owner/name", e.g. "acme/billing-api".')
    .optional()
    .describe(
      'Which repository, as "owner/name". Omit it when the organisation tracks exactly one, or to sweep every tracked repository for the actions that support it (commits, pull_requests, deployments, deployment_failures, ci_failures, summary). last_commit and checks need one named repository.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("How many rows to return per repository."),
  branch: z
    .string()
    .optional()
    .describe("Restrict to one branch. Defaults to the repository's default branch."),
  environment: z
    .string()
    .optional()
    .describe(
      'Restrict deployments to one environment, e.g. "production". Omit to see every environment.',
    ),
  state: z
    .enum(["open", "closed", "merged", "all"])
    .default("open")
    .describe(
      'Pull request state. "merged" means closed and actually merged, which is not the same as closed.',
    ),
  since: z
    .string()
    .optional()
    .describe(
      'Only consider activity newer than this. Either a relative window — "24h", "7d", "2w" — or an ISO 8601 timestamp. Omit for no lower bound.',
    ),
  ref: z
    .string()
    .optional()
    .describe(
      "For action=checks: the commit SHA or branch to read check runs for. Defaults to the default branch tip.",
    ),
});

/**
 * One envelope for every action.
 *
 * The alternative — a different top-level shape per action — means a caller
 * cannot write one piece of handling code, and a model cannot learn the
 * response format from a single example. `items` is deliberately untyped here:
 * a commit and a deployment status share no fields, and inventing a union that
 * covers both would describe neither.
 */
export const githubActivityOutput = z.object({
  action: z.string(),
  /** Which repositories were actually consulted, as "owner/name". */
  repositories: z.array(z.string()),
  items: z.array(z.unknown()),
  /** The one-line headline, identical to the first line of the text. */
  summary: z.string(),
  /** Caps applied, repositories skipped, calls that failed. Never silent. */
  notes: z.array(z.string()),
});

type Input = z.infer<typeof githubActivityInput>;

/* ------------------------------------------------------------- resolution */

function fullName(repo: Repository): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Which repositories this call touches.
 *
 * A named repository that is not tracked is answered with the list of ones that
 * are, because the overwhelmingly likely cause is a near-miss on the name and
 * an agent given a bare "not found" will guess again rather than look.
 */
async function resolveRepos(
  orgId: number,
  named: string | undefined,
  notes: string[],
): Promise<Repository[]> {
  const tracked = (await listRepositories(orgId)) as Repository[];

  if (tracked.length === 0) {
    throw new UserError(
      "This organisation has no GitHub repository connected, so there is nothing to report. An administrator connects one by installing the Sadhak GitHub App and tracking the repository in connector settings.",
      { status: 404, type: "no-repositories" },
    );
  }

  if (named) {
    const [owner, name] = named.split("/") as [string, string];
    const found = await findRepository(orgId, owner, name);
    if (!found) {
      throw new UserError(
        `${named} is not connected to this organisation. Connected repositories: ${tracked.map(fullName).join(", ")}.`,
        { status: 404, type: "unknown-repository" },
      );
    }
    return [found as Repository];
  }

  if (tracked.length > MAX_REPOS) {
    notes.push(
      `This organisation tracks ${tracked.length} repositories; only the first ${MAX_REPOS} were checked. Name one with "repo" to look at the rest.`,
    );
    return tracked.slice(0, MAX_REPOS);
  }
  return tracked;
}

/** Actions where sweeping several repositories would answer a different question. */
async function oneRepo(
  orgId: number,
  named: string | undefined,
  action: string,
  notes: string[],
): Promise<Repository> {
  const repos = await resolveRepos(orgId, named, notes);
  if (repos.length > 1) {
    throw new UserError(
      `action="${action}" reports on one repository and this organisation has several. Pass repo as one of: ${repos.map(fullName).join(", ")}.`,
      { status: 422, type: "ambiguous-repository" },
    );
  }
  return repos[0] as Repository;
}

/**
 * "7d" and "2026-07-01" both mean a lower bound.
 *
 * Relative windows are accepted because that is how the question is actually
 * asked, and a model converting "last week" to an absolute timestamp itself is
 * a model that will occasionally get the year wrong.
 */
export function parseSince(since: string | undefined): Date | null {
  if (!since) return null;

  const relative = /^(\d+)\s*(h|d|w)$/i.exec(since.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? "d").toLowerCase();
    const hours = unit === "h" ? amount : unit === "d" ? amount * 24 : amount * 24 * 7;
    return new Date(Date.now() - hours * 3_600_000);
  }

  const absolute = new Date(since);
  if (Number.isNaN(absolute.getTime())) {
    throw new UserError(
      `Could not read "${since}" as a time. Use a relative window like "24h", "7d" or "2w", or an ISO 8601 timestamp.`,
      { status: 422, type: "bad-since" },
    );
  }
  return absolute;
}

async function repoGet<T>(
  repo: Repository,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const token = await tokenForRepo(repo);
  return getJson<T>(
    `${GITHUB_API}/repos/${repo.owner}/${repo.name}${path}`,
    token,
    signal,
  );
}

/**
 * Runs one read per repository and keeps the failures as notes.
 *
 * `allSettled` rather than `all` because a single repository the App has lost
 * access to must not blank the answer for the four that are fine — and because
 * the reason it failed is itself worth reporting.
 */
async function perRepo<T>(
  repos: Repository[],
  notes: string[],
  fn: (repo: Repository) => Promise<T[]>,
): Promise<T[]> {
  const settled = await Promise.allSettled(repos.map(fn));
  const out: T[] = [];

  settled.forEach((result, i) => {
    const repo = repos[i] as Repository;
    if (result.status === "fulfilled") out.push(...result.value);
    else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      notes.push(`${fullName(repo)} could not be read: ${reason}`);
    }
  });

  return out;
}

/* -------------------------------------------------------- GitHub payloads */

interface CommitPayload {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { login?: string } | null;
}

interface PullPayload {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  user?: { login?: string } | null;
  head?: { ref?: string };
  base?: { ref?: string };
}

interface DeploymentPayload {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  creator?: { login?: string } | null;
}

interface DeploymentStatusPayload {
  state: string;
  description: string | null;
  environment_url?: string | null;
  log_url?: string | null;
  created_at: string;
  creator?: { login?: string } | null;
}

interface WorkflowRunPayload {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_number: number;
  run_attempt: number;
  event: string;
  created_at: string;
  updated_at: string;
  actor?: { login?: string } | null;
}

interface CheckRunPayload {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
  output?: { title?: string | null; summary?: string | null };
}

/* ------------------------------------------------------------- primitives */

function firstLine(message: string): string {
  return (message.split("\n")[0] ?? "").trim();
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function when(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown time";

  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  // Relative for anything recent, because "3h ago" is what the question was
  // about; absolute past a week, because "just under 40 days ago" is not.
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d ago`;
  return at.toISOString().slice(0, 10);
}

async function branchOf(
  repo: Repository,
  requested: string | undefined,
): Promise<string> {
  return requested ?? repo.defaultBranch ?? "main";
}

async function commitsFor(
  repo: Repository,
  input: Input,
  limit: number,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const branch = await branchOf(repo, input.branch);
  const since = parseSince(input.since);
  const query = new URLSearchParams({ sha: branch, per_page: String(limit) });
  if (since) query.set("since", since.toISOString());

  const rows = await repoGet<CommitPayload[]>(repo, `/commits?${query}`, signal);
  return rows.map((row) => ({
    repository: fullName(repo),
    sha: row.sha,
    message: firstLine(row.commit.message),
    author: row.author?.login ?? row.commit.author?.name ?? "unknown",
    committed_at: row.commit.committer?.date ?? row.commit.author?.date ?? null,
    branch,
    url: row.html_url,
  }));
}

async function checksFor(
  repo: Repository,
  ref: string,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const body = await repoGet<{ check_runs?: CheckRunPayload[] }>(
    repo,
    `/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`,
    signal,
  );
  return (body.check_runs ?? []).map((run) => ({
    repository: fullName(repo),
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    started_at: run.started_at,
    completed_at: run.completed_at,
    title: run.output?.title ?? null,
    url: run.html_url,
  }));
}

/** A deployment is only as interesting as its current state, so they arrive together. */
async function deploymentsFor(
  repo: Repository,
  input: Input,
  scan: number,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const query = new URLSearchParams({ per_page: String(scan) });
  if (input.environment) query.set("environment", input.environment);
  if (input.branch) query.set("ref", input.branch);

  const deployments = await repoGet<DeploymentPayload[]>(
    repo,
    `/deployments?${query}`,
    signal,
  );
  const since = parseSince(input.since);
  const inWindow = since
    ? deployments.filter((d) => new Date(d.created_at) >= since)
    : deployments;

  return Promise.all(
    inWindow.map(async (deployment) => {
      let state = "unknown";
      let statusAt: string | null = null;
      let logUrl: string | null = null;
      let detail: string | null = null;

      try {
        const statuses = await repoGet<DeploymentStatusPayload[]>(
          repo,
          `/deployments/${deployment.id}/statuses?per_page=1`,
          signal,
        );
        const latest = statuses[0];
        if (latest) {
          state = latest.state;
          statusAt = latest.created_at;
          logUrl = latest.log_url ?? latest.environment_url ?? null;
          detail = latest.description;
        } else {
          // A deployment with no status was created and never reported on.
          // That is a real and common state, and it is not a failure.
          state = "pending";
        }
      } catch {
        // One unreadable status must not cost the whole deployment row.
        state = "unknown";
      }

      return {
        repository: fullName(repo),
        id: deployment.id,
        environment: deployment.environment,
        state,
        ref: deployment.ref,
        sha: deployment.sha,
        task: deployment.task,
        description: deployment.description,
        creator: deployment.creator?.login ?? null,
        created_at: deployment.created_at,
        status_at: statusAt,
        detail,
        log_url: logUrl,
      };
    }),
  );
}

async function failedRunsFor(
  repo: Repository,
  input: Input,
  limit: number,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const query = new URLSearchParams({ status: "failure", per_page: String(limit) });
  if (input.branch) query.set("branch", input.branch);

  const body = await repoGet<{ workflow_runs?: WorkflowRunPayload[] }>(
    repo,
    `/actions/runs?${query}`,
    signal,
  );
  const since = parseSince(input.since);

  return (body.workflow_runs ?? [])
    .filter((run) => !since || new Date(run.created_at) >= since)
    .map((run) => ({
      repository: fullName(repo),
      kind: "workflow_run" as const,
      workflow: run.name,
      run_id: run.id,
      attempt: run.run_attempt,
      branch: run.head_branch,
      sha: run.head_sha,
      event: run.event,
      conclusion: run.conclusion,
      actor: run.actor?.login ?? null,
      failed_at: run.updated_at,
      url: run.html_url,
    }));
}

/* ----------------------------------------------------------------- actions */

async function runAction(
  ctx: McpContext,
  input: Input,
  notes: string[],
): Promise<{ repositories: string[]; items: unknown[]; summary: string }> {
  const { orgId } = ctx;

  switch (input.action) {
    case "repos": {
      const repos = await resolveRepos(orgId, input.repo, notes);
      const items = repos.map((repo) => ({
        repository: fullName(repo),
        default_branch: repo.defaultBranch,
        /** Null means no App installation covers it and reads fall back to the
         * deployment's own token, which is worth seeing. */
        installation_id: repo.installationId,
        tracked_since: repo.createdAt,
      }));
      return {
        repositories: repos.map(fullName),
        items,
        summary: `${items.length} repository/repositories connected: ${repos.map(fullName).join(", ")}.`,
      };
    }

    case "last_commit": {
      const repo = await oneRepo(orgId, input.repo, "last_commit", notes);
      const [commit] = await commitsFor(repo, input, 1);
      if (!commit) {
        return {
          repositories: [fullName(repo)],
          items: [],
          summary: `No commits on ${await branchOf(repo, input.branch)} in ${fullName(repo)}${input.since ? " within that window" : ""}.`,
        };
      }

      // The commit alone rarely answers the question behind the question,
      // which is almost always "and is it green?".
      let checks: Array<Record<string, unknown>> = [];
      try {
        checks = await checksFor(repo, String(commit.sha));
      } catch (error) {
        notes.push(
          `Check runs for ${shortSha(String(commit.sha))} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const failing = checks.filter((c) => c.conclusion === "failure");
      const verdict =
        checks.length === 0
          ? "no checks reported"
          : failing.length > 0
            ? `${failing.length} of ${checks.length} checks failing`
            : `all ${checks.length} checks passing`;

      return {
        repositories: [fullName(repo)],
        items: [{ ...commit, checks, checks_verdict: verdict }],
        summary: `${fullName(repo)} — ${shortSha(String(commit.sha))} "${commit.message}" by ${commit.author}, ${when(String(commit.committed_at ?? ""))} — ${verdict}.`,
      };
    }

    case "commits": {
      const repos = await resolveRepos(orgId, input.repo, notes);
      const items = await perRepo(repos, notes, (repo) =>
        commitsFor(repo, input, input.limit),
      );
      return {
        repositories: repos.map(fullName),
        items,
        summary: `${items.length} commit(s) across ${repos.length} repository/repositories.`,
      };
    }

    case "pull_requests": {
      const repos = await resolveRepos(orgId, input.repo, notes);
      const since = parseSince(input.since);
      /** GitHub has no "merged" state; a merged PR is a closed one that has a
       * merge timestamp, and conflating the two is how "what shipped" turns
       * into a list that includes everything abandoned. */
      const apiState = input.state === "merged" ? "closed" : input.state;

      const items = await perRepo(repos, notes, async (repo) => {
        const query = new URLSearchParams({
          state: apiState,
          sort: "updated",
          direction: "desc",
          // Over-fetch when filtering client-side, or a page of closed-unmerged
          // PRs returns nothing for state="merged".
          per_page: String(
            input.state === "merged" ? Math.min(input.limit * 3, 100) : input.limit,
          ),
        });
        if (input.branch) query.set("base", input.branch);

        const rows = await repoGet<PullPayload[]>(repo, `/pulls?${query}`);
        return rows
          .filter((pr) => (input.state === "merged" ? pr.merged_at !== null : true))
          .filter((pr) => !since || new Date(pr.updated_at) >= since)
          .slice(0, input.limit)
          .map((pr) => ({
            repository: fullName(repo),
            number: pr.number,
            title: pr.title,
            state: pr.merged_at ? "merged" : pr.state,
            draft: pr.draft ?? false,
            author: pr.user?.login ?? "unknown",
            head: pr.head?.ref ?? null,
            base: pr.base?.ref ?? null,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            merged_at: pr.merged_at,
            url: pr.html_url,
          }));
      });

      return {
        repositories: repos.map(fullName),
        items,
        summary: `${items.length} ${input.state} pull request(s) across ${repos.length} repository/repositories.`,
      };
    }

    case "deployments": {
      const repos = await resolveRepos(orgId, input.repo, notes);
      const items = await perRepo(repos, notes, (repo) =>
        deploymentsFor(repo, input, Math.min(input.limit, DEPLOYMENT_SCAN)),
      );
      const failed = items.filter(
        (d) =>
          (d as { state: string }).state === "failure" ||
          (d as { state: string }).state === "error",
      );
      return {
        repositories: repos.map(fullName),
        items,
        summary: `${items.length} deployment(s)${input.environment ? ` to ${input.environment}` : ""}${failed.length > 0 ? `, ${failed.length} of them failed` : ""}.`,
      };
    }

    case "deployment_failures": {
      const repos = await resolveRepos(orgId, input.repo, notes);

      /**
       * Two independent things are called "a deployment failing" and an answer
       * that covers only one of them is wrong for half of all setups. A team
       * using GitHub's Deployments API has failed *deployment statuses*; a team
       * deploying from a workflow with no Deployments call at all has only a
       * failed *workflow run*. Both are reported, labelled.
       */
      const deployments = await perRepo(repos, notes, async (repo) => {
        const all = await deploymentsFor(repo, input, DEPLOYMENT_SCAN);
        return all
          .filter((d) => {
            const state = (d as { state: string }).state;
            return state === "failure" || state === "error";
          })
          .slice(0, input.limit)
          .map((d) => ({ ...d, kind: "deployment" as const }));
      });

      const runs = await perRepo(repos, notes, (repo) =>
        failedRunsFor(repo, input, input.limit),
      );

      const items = [...deployments, ...runs];
      const headline =
        items.length === 0
          ? `No failed deployments or workflow runs${input.since ? ` in the last ${input.since}` : ""} across ${repos.map(fullName).join(", ")}.`
          : `${deployments.length} failed deployment(s) and ${runs.length} failed workflow run(s) across ${repos.length} repository/repositories.`;

      return { repositories: repos.map(fullName), items, summary: headline };
    }

    case "ci_failures": {
      const repos = await resolveRepos(orgId, input.repo, notes);
      const since = parseSince(input.since);
      const repoIds = repos.map((r) => r.id);

      /**
       * Local, and org-scoped by the row itself rather than by the repository
       * join — a query that scoped only through `repositories` would still be
       * correct today and would stop being correct the moment a repository row
       * is shared or re-parented.
       */
      const rows = await db
        .select({
          id: ciFailures.id,
          repositoryId: ciFailures.repositoryId,
          owner: reposTable.owner,
          name: reposTable.name,
          runId: ciFailures.runId,
          runAttempt: ciFailures.runAttempt,
          workflowName: ciFailures.workflowName,
          branch: ciFailures.branch,
          headSha: ciFailures.headSha,
          prNumber: ciFailures.prNumber,
          jobName: ciFailures.jobName,
          stepName: ciFailures.stepName,
          failureExcerpt: ciFailures.failureExcerpt,
          analysis: ciFailures.analysis,
          state: ciFailures.state,
          htmlUrl: ciFailures.htmlUrl,
          createdAt: ciFailures.createdAt,
        })
        .from(ciFailures)
        .innerJoin(reposTable, eq(reposTable.id, ciFailures.repositoryId))
        .where(and(eq(ciFailures.orgId, orgId)))
        .orderBy(desc(ciFailures.createdAt))
        .limit(input.limit * Math.max(repos.length, 1));

      const items = rows
        .filter((row) => repoIds.includes(row.repositoryId))
        .filter((row) => !since || row.createdAt >= since)
        .slice(0, input.limit * Math.max(repos.length, 1))
        .map((row) => ({
          repository: `${row.owner}/${row.name}`,
          kind: "analysed_ci_failure" as const,
          id: row.id,
          workflow: row.workflowName,
          run_id: row.runId,
          attempt: row.runAttempt,
          branch: row.branch,
          sha: row.headSha,
          pr_number: row.prNumber,
          job: row.jobName,
          step: row.stepName,
          excerpt: row.failureExcerpt,
          analysis: row.analysis,
          state: row.state,
          failed_at: row.createdAt,
          url: row.htmlUrl,
        }));

      return {
        repositories: repos.map(fullName),
        items,
        summary:
          items.length === 0
            ? "No CI failures have been captured and analysed for this organisation. Only default-branch failures since the GitHub App was installed are captured."
            : `${items.length} analysed CI failure(s), newest first.`,
      };
    }

    case "checks": {
      const repo = await oneRepo(orgId, input.repo, "checks", notes);
      const ref = input.ref ?? (await branchOf(repo, input.branch));
      const items = await checksFor(repo, ref);
      const failing = items.filter((c) => c.conclusion === "failure");
      const pending = items.filter((c) => c.status !== "completed");

      return {
        repositories: [fullName(repo)],
        items,
        summary:
          items.length === 0
            ? `No checks have reported on ${ref} in ${fullName(repo)}.`
            : `${items.length} check(s) on ${ref}: ${failing.length} failing, ${pending.length} still running.`,
      };
    }

    case "summary": {
      const repos = await resolveRepos(orgId, input.repo, notes);
      /** Four reads per repository, so the sweep is tighter than elsewhere. */
      const scope = repos.slice(0, 3);
      if (repos.length > scope.length) {
        notes.push(
          `Summarised the first ${scope.length} of ${repos.length} repositories; ask again naming the others.`,
        );
      }

      const items = await Promise.all(
        scope.map(async (repo) => {
          const [commit, pulls, deployments, runs] = await Promise.allSettled([
            commitsFor(repo, { ...input, since: undefined }, 1),
            repoGet<PullPayload[]>(
              repo,
              "/pulls?state=open&sort=updated&direction=desc&per_page=5",
            ),
            deploymentsFor(repo, { ...input, since: undefined }, 10),
            failedRunsFor(repo, { ...input, since: input.since ?? "7d" }, 5),
          ]);

          if (commit.status === "rejected") {
            notes.push(
              `${fullName(repo)} could not be read: ${commit.reason instanceof Error ? commit.reason.message : String(commit.reason)}`,
            );
          }

          /** Latest deployment per environment, which is what "is production
           * up to date" actually asks — a flat list buries it. */
          const latestByEnvironment = new Map<string, Record<string, unknown>>();
          if (deployments.status === "fulfilled") {
            for (const deployment of deployments.value) {
              const environment = String(deployment.environment);
              if (!latestByEnvironment.has(environment)) {
                latestByEnvironment.set(environment, deployment);
              }
            }
          }

          return {
            repository: fullName(repo),
            default_branch: repo.defaultBranch,
            last_commit: commit.status === "fulfilled" ? (commit.value[0] ?? null) : null,
            open_pull_requests:
              pulls.status === "fulfilled"
                ? pulls.value.map((pr) => ({
                    number: pr.number,
                    title: pr.title,
                    author: pr.user?.login ?? "unknown",
                    draft: pr.draft ?? false,
                    updated_at: pr.updated_at,
                    url: pr.html_url,
                  }))
                : [],
            latest_deployments: [...latestByEnvironment.values()],
            recent_failed_runs: runs.status === "fulfilled" ? runs.value : [],
          };
        }),
      );

      const brokenCount = items.filter(
        (item) =>
          item.recent_failed_runs.length > 0 ||
          item.latest_deployments.some(
            (d) =>
              (d as { state: string }).state === "failure" ||
              (d as { state: string }).state === "error",
          ),
      ).length;

      return {
        repositories: scope.map(fullName),
        items,
        summary:
          brokenCount === 0
            ? `${items.length} repository/repositories, nothing currently failing.`
            : `${items.length} repository/repositories, ${brokenCount} with something failing.`,
      };
    }
  }
}

/* ------------------------------------------------------------- rendering */

/**
 * What the model reads.
 *
 * Deliberately not serialised JSON. The same payload is already on
 * `structuredContent` for anything that wants to compute with it; repeating it
 * here would spend a large share of the context window on punctuation and field
 * names the model has to re-derive meaning from. Prose with the URL on every
 * row is denser and is directly relayable to a human.
 */
export function renderGithub(
  action: string,
  payload: { repositories: string[]; items: unknown[]; summary: string },
  notes: string[],
): string {
  const lines: string[] = [payload.summary];
  const rows = payload.items as Array<Record<string, unknown>>;

  if (rows.length > 0) {
    lines.push("");

    for (const row of rows) {
      switch (action) {
        case "repos":
          lines.push(
            `  ${row.repository} — default branch ${row.default_branch}${row.installation_id === null ? " (no App installation; read with the deployment token)" : ""}`,
          );
          break;

        case "last_commit":
        case "commits":
          lines.push(
            `  ${shortSha(String(row.sha))} "${row.message}" — ${row.author}, ${when(String(row.committed_at ?? ""))} ${row.url}`,
          );
          if (Array.isArray(row.checks)) {
            for (const check of row.checks as Array<Record<string, unknown>>) {
              lines.push(
                `      check ${check.name}: ${check.conclusion ?? check.status}${check.title ? ` — ${check.title}` : ""}`,
              );
            }
          }
          break;

        case "pull_requests":
          lines.push(
            `  #${row.number} ${row.state}${row.draft ? " (draft)" : ""} "${row.title}" — ${row.author}, updated ${when(String(row.updated_at ?? ""))} ${row.url}`,
          );
          break;

        case "deployments":
          lines.push(
            `  ${row.environment}: ${row.state} — ${row.ref} @ ${shortSha(String(row.sha))}, ${when(String(row.status_at ?? row.created_at ?? ""))}${row.creator ? ` by ${row.creator}` : ""}`,
          );
          if (row.detail) lines.push(`      ${row.detail}`);
          if (row.log_url) lines.push(`      ${row.log_url}`);
          break;

        case "deployment_failures":
          if (row.kind === "deployment") {
            lines.push(
              `  DEPLOYMENT ${row.repository} ${row.environment}: ${row.state} — ${row.ref} @ ${shortSha(String(row.sha))}, ${when(String(row.status_at ?? row.created_at ?? ""))}`,
            );
            if (row.detail) lines.push(`      ${row.detail}`);
            if (row.log_url) lines.push(`      ${row.log_url}`);
          } else {
            lines.push(
              `  WORKFLOW ${row.repository} "${row.workflow}" failed on ${row.branch} @ ${shortSha(String(row.sha))}, ${when(String(row.failed_at ?? ""))}${row.actor ? ` (${row.actor})` : ""}`,
            );
            lines.push(`      ${row.url}`);
          }
          break;

        case "ci_failures": {
          lines.push(
            `  ${row.repository} "${row.workflow}" on ${row.branch} @ ${shortSha(String(row.sha))}, ${when(String(row.failed_at ?? ""))} — ${row.state}`,
          );
          if (row.job)
            lines.push(`      failed at: ${row.job}${row.step ? ` / ${row.step}` : ""}`);
          const analysis = row.analysis as Record<string, unknown> | null;
          if (analysis?.cause) lines.push(`      cause: ${analysis.cause}`);
          if (analysis?.recommendation) {
            lines.push(`      recommendation: ${analysis.recommendation}`);
          }
          if (!analysis) {
            lines.push("      not analysed yet — only the raw excerpt is available.");
          }
          lines.push(`      ${row.url}`);
          break;
        }

        case "checks":
          lines.push(
            `  ${row.name}: ${row.conclusion ?? row.status}${row.title ? ` — ${row.title}` : ""} ${row.url}`,
          );
          break;

        case "summary": {
          lines.push(`  ${row.repository} (${row.default_branch})`);
          const commit = row.last_commit as Record<string, unknown> | null;
          lines.push(
            commit
              ? `      last commit: ${shortSha(String(commit.sha))} "${commit.message}" — ${commit.author}, ${when(String(commit.committed_at ?? ""))}`
              : "      last commit: unknown",
          );

          const pulls = (row.open_pull_requests ?? []) as Array<Record<string, unknown>>;
          lines.push(`      open pull requests: ${pulls.length}`);
          for (const pr of pulls.slice(0, 5)) {
            lines.push(
              `        #${pr.number} "${pr.title}" — ${pr.author}${pr.draft ? " (draft)" : ""}, updated ${when(String(pr.updated_at ?? ""))}`,
            );
          }

          const deployments = (row.latest_deployments ?? []) as Array<
            Record<string, unknown>
          >;
          lines.push(
            deployments.length === 0
              ? "      deployments: none recorded"
              : "      latest deployment per environment:",
          );
          for (const deployment of deployments) {
            lines.push(
              `        ${deployment.environment}: ${deployment.state} — ${shortSha(String(deployment.sha))}, ${when(String(deployment.status_at ?? deployment.created_at ?? ""))}`,
            );
          }

          const failed = (row.recent_failed_runs ?? []) as Array<Record<string, unknown>>;
          lines.push(`      failed workflow runs recently: ${failed.length}`);
          for (const run of failed.slice(0, 3)) {
            lines.push(
              `        "${run.workflow}" on ${run.branch}, ${when(String(run.failed_at ?? ""))} ${run.url}`,
            );
          }
          break;
        }

        default:
          lines.push(`  ${JSON.stringify(row)}`);
      }
    }
  }

  if (notes.length > 0) {
    /**
     * Named as limits on the answer rather than as errors. An agent that reads
     * "5 of 40 repositories checked" as a warning it may ignore will report a
     * partial sweep as a complete one, which is the failure this whole block
     * exists to prevent.
     */
    lines.push("", "What this answer does NOT cover:");
    for (const note of notes) lines.push(`  - ${note}`);
  }

  return lines.join("\n");
}

export async function githubActivity(ctx: McpContext, input: Input) {
  const notes: string[] = [];
  const payload = await runAction(ctx, input, notes);

  return {
    structured: {
      action: input.action,
      repositories: payload.repositories,
      items: payload.items,
      summary: payload.summary,
      notes,
    },
    text: renderGithub(input.action, payload, notes),
  };
}
