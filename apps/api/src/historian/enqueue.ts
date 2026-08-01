import { edges as edgesTable, nodes as nodesTable } from "@sadhak/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { enqueue } from "../jobs/queue.js";
import { createRun, preflight } from "./runs.js";

/**
 * After a crawl, queue the unexplained edges worth explaining.
 *
 * Ordered by the impact of what they connect, so a reviewer's queue fills with
 * what matters rather than whatever the crawler happened to write last. Capped
 * per org, and deduped by edge, so a re-crawl does not double-queue.
 */

export async function enqueueUnexplainedEdges(orgId: number): Promise<number> {
  const candidates = await db
    .select({ id: edgesTable.id })
    .from(edgesTable)
    .innerJoin(nodesTable, eq(nodesTable.id, edgesTable.dstId))
    .where(
      and(
        eq(edgesTable.orgId, orgId),
        eq(edgesTable.state, "active"),
        sql`NOT EXISTS (SELECT 1 FROM rationale_links rl WHERE rl.edge_id = ${edgesTable.id})`,
      ),
    )
    .orderBy(desc(nodesTable.criticality))
    .limit(config.HISTORIAN_MAX_QUEUED_PER_ORG);

  if (candidates.length === 0) return 0;

  // Refuse rather than start something that cannot finish: a half-run spends
  // the day's quota and leaves the reviewer an arbitrary subset.
  const check = await preflight(candidates.length);
  const edgeIds = check.fits
    ? candidates.map((c) => c.id)
    : candidates.slice(0, check.edgesThatWouldFit).map((c) => c.id);

  if (edgeIds.length === 0) return 0;

  const runId = await createRun({
    orgId,
    kind: "edge",
    edgeIds,
    startedBy: "cartographer",
  });

  await enqueue(
    "historian.run",
    { runId },
    { orgId, dedupeKey: `historian.run:${runId}`, priority: -1 },
  );

  return edgeIds.length;
}
