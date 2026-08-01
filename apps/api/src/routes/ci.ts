import { ciFailures, repositories } from "@sadhak/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db.js";
import { NotFoundError } from "../errors.js";
import { requireCapability } from "../middleware/auth.js";

export const ciRoutes = new Hono();

/**
 * What the Slack button opens.
 *
 * The alert is deliberately thin, which only works if the detail is one click
 * away and complete: the log that failed, what the merge touched, the passages
 * the conclusion rests on, and every past occurrence. A reader who cannot check
 * the reasoning has been asked to trust it, and this is a product about not
 * having to do that.
 */

ciRoutes.get("/ci", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");

  const rows = await db
    .select({
      id: ciFailures.id,
      runId: ciFailures.runId,
      headSha: ciFailures.headSha,
      branch: ciFailures.branch,
      workflowName: ciFailures.workflowName,
      jobName: ciFailures.jobName,
      stepName: ciFailures.stepName,
      htmlUrl: ciFailures.htmlUrl,
      prNumber: ciFailures.prNumber,
      state: ciFailures.state,
      analysis: ciFailures.analysis,
      createdAt: ciFailures.createdAt,
      owner: repositories.owner,
      repo: repositories.name,
    })
    .from(ciFailures)
    .innerJoin(repositories, eq(repositories.id, ciFailures.repositoryId))
    .where(eq(ciFailures.orgId, orgId))
    .orderBy(desc(ciFailures.createdAt))
    .limit(50);

  return c.json({ failures: rows });
});

ciRoutes.get("/ci/:id", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new NotFoundError();

  const [row] = await db
    .select({
      failure: ciFailures,
      owner: repositories.owner,
      repo: repositories.name,
    })
    .from(ciFailures)
    // Scoped by org in the where clause, not by the id alone: a failure id is a
    // small integer and guessing one from another tenant must find nothing.
    .where(and(eq(ciFailures.id, id), eq(ciFailures.orgId, orgId)))
    .innerJoin(repositories, eq(repositories.id, ciFailures.repositoryId))
    .limit(1);

  if (!row) throw new NotFoundError();

  return c.json({
    failure: { ...row.failure, owner: row.owner, repo: row.repo },
  });
});
