import { ciFailures, repositories } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { log } from "../log.js";

/**
 * Getting a failure onto the record before anything can go wrong with it.
 *
 * Everything downstream — reading logs, searching, the model — can fail or be
 * unconfigured. The row is written first so that a failure is always visible in
 * the UI even when nothing could be worked out about it, and so a retry has
 * somewhere to attach its progress rather than starting over.
 */

export interface CapturedRun {
  orgId: number;
  owner: string;
  name: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  branch: string;
  workflowName: string;
  htmlUrl: string;
  prNumber: number | null;
}

/**
 * Which org tracks this repository.
 *
 * By owner and name rather than installation id, because the CI path is
 * reachable for a repository connected with a plain token and no App install —
 * `workflow_run` arrives from the App, but the repository may have been tracked
 * before the install and carry a null installation_id.
 */
export async function orgForRepository(
  owner: string,
  name: string,
): Promise<number | null> {
  const [row] = await db
    .select({ orgId: repositories.orgId })
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, name)))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * Writes the failure, or returns null if this exact attempt is already known.
 *
 * Null rather than the existing id, on purpose. GitHub redelivers webhooks and
 * the queue retries; returning the id would let a redelivery re-analyse and
 * re-post a failure the channel has already seen, which is the specific way
 * this feature would become something people turn off.
 */
export async function recordCiFailure(run: CapturedRun): Promise<number | null> {
  const [repo] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, run.orgId),
        eq(repositories.owner, run.owner),
        eq(repositories.name, run.name),
      ),
    )
    .limit(1);
  if (!repo) return null;

  const [inserted] = await db
    .insert(ciFailures)
    .values({
      orgId: run.orgId,
      repositoryId: repo.id,
      runId: run.runId,
      runAttempt: run.runAttempt,
      headSha: run.headSha,
      branch: run.branch,
      workflowName: run.workflowName,
      htmlUrl: run.htmlUrl,
      prNumber: run.prNumber,
    })
    // The unique key is (org, run, attempt). A conflict means we have seen this
    // attempt, so the insert yields nothing and the caller stops.
    .onConflictDoNothing()
    .returning({ id: ciFailures.id });

  if (!inserted) return null;

  log().info(
    { event: "ci_failure_captured", failureId: inserted.id, runId: run.runId },
    "ci: failure captured",
  );
  return inserted.id;
}

/** Records why an analysis stopped, so a silent failure is still queryable. */
export async function markCiFailed(failureId: number, reason: string): Promise<void> {
  await db
    .update(ciFailures)
    .set({ state: "failed", lastError: reason.slice(0, 500) })
    .where(eq(ciFailures.id, failureId));
}
