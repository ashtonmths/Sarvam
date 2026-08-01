import { randomUUID } from "node:crypto";
import {
  edges as edgesTable,
  historianRunEdges,
  historianRuns,
  nodes as nodesTable,
} from "@sadhak/shared/schema";
import { and, sql as drizzleSql, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db, sql } from "../db.js";
import { UserError } from "../errors.js";
import { derivedConcurrency, orgBudget, requestsRemainingToday } from "./budget.js";
import { type EdgeGoal, type LoopOutcome, runLoop } from "./loop.js";
import type { LoopCtx } from "./tools/execute.js";

/**
 * The exit-interview fan-out. One manager per run; independent loops inside it
 * under a semaphore — a run is one cancellable, heartbeated unit of work
 * rather than N orphan jobs.
 *
 * The arithmetic, stated in the open, because it drives real design:
 *
 *   per loop      ~5 model calls
 *   12-edge run   60 requests   ← the demo run
 *   free account  50/day        → one demo run does not fit in a whole day
 *   after $10     1000/day      → the same run is 6% of the day
 *   account-wide  20/min        → 60 requests need ≥3 minutes at ANY concurrency
 *
 * So: the credit is effectively a prerequisite, the preflight refuses runs it
 * cannot finish, and concurrency is *derived* from the rate limit rather than
 * asserted.
 */

export interface PreflightRefusal {
  fits: false;
  remaining: number;
  estimated: number;
  edgesThatWouldFit: number;
}

export type Preflight = { fits: true; estimated: number } | PreflightRefusal;

export async function preflight(edgeCount: number): Promise<Preflight> {
  const estimated = edgeCount * config.HISTORIAN_EXPECTED_CALLS_PER_LOOP;
  const remaining = await requestsRemainingToday();

  if (estimated <= remaining) return { fits: true, estimated };

  // Half a fan-out is strictly worse than none: it spends the day's quota and
  // hands the reviewer an arbitrary half with no signal about which half is
  // missing. Refuse before any row is written, and say what *would* fit.
  return {
    fits: false,
    remaining,
    estimated,
    edgesThatWouldFit: Math.floor(remaining / config.HISTORIAN_EXPECTED_CALLS_PER_LOOP),
  };
}

/**
 * Knowledge concentration, as a candidate list a human launches — never an
 * automatic trigger. An edge qualifies when the departing person is its only
 * confirmed explainer, or when they own an endpoint of an entirely unexplained
 * edge.
 */
export async function edgesOnlyExplainedBy(
  orgId: number,
  personNodeId: number,
  authorName: string,
): Promise<number[]> {
  const rows = (await sql`
    SELECT DISTINCT e.id FROM edges e
    WHERE e.org_id = ${orgId} AND (
      (EXISTS (SELECT 1 FROM rationale_links rl JOIN rationale r ON r.id = rl.rationale_id
               WHERE rl.edge_id = e.id AND r.state='confirmed' AND r.author = ${authorName})
       AND NOT EXISTS (SELECT 1 FROM rationale_links rl JOIN rationale r ON r.id = rl.rationale_id
               WHERE rl.edge_id = e.id AND r.state='confirmed'
                 AND r.author IS DISTINCT FROM ${authorName}))
      OR (EXISTS (SELECT 1 FROM edges o WHERE o.kind='OWNED_BY' AND o.dst_id = ${personNodeId}
                  AND o.src_id IN (e.src_id, e.dst_id))
          AND NOT EXISTS (SELECT 1 FROM rationale_links rl JOIN rationale r ON r.id = rl.rationale_id
                  WHERE rl.edge_id = e.id AND r.state='confirmed'))
    )
    LIMIT ${config.HISTORIAN_FANOUT_MAX_EDGES}
  `) as unknown as Array<{ id: string | number }>;

  return rows.map((r) => Number(r.id));
}

export async function createRun(input: {
  orgId: number;
  kind: "edge" | "exit_interview";
  edgeIds: number[];
  subjectNodeId?: number | null;
  startedBy: string;
}): Promise<string> {
  const remaining = await requestsRemainingToday();
  const budget = Math.min(
    Math.ceil(input.edgeIds.length * config.HISTORIAN_EXPECTED_CALLS_PER_LOOP * 1.5),
    remaining,
  );

  const [run] = await db
    .insert(historianRuns)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      subjectNodeId: input.subjectNodeId ?? null,
      state: "queued",
      edgesTotal: input.edgeIds.length,
      requestBudget: budget,
      startedBy: input.startedBy,
    })
    .returning({ id: historianRuns.id });

  const runId = run?.id;
  if (!runId) throw new UserError("Could not create the run");

  if (input.edgeIds.length > 0) {
    await db
      .insert(historianRunEdges)
      .values(input.edgeIds.map((edgeId) => ({ runId, edgeId })))
      .onConflictDoNothing();
  }

  return runId;
}

/**
 * Executes every edge in the run through a semaphore whose width comes from
 * the rate limit. Beyond that number loops merely queue inside `llm.ts`'s
 * bucket: zero extra throughput, a wider blast radius on cancel.
 */
export async function executeRun(
  runId: string,
  hooks: { heartbeat?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<void> {
  const [run] = await db
    .select()
    .from(historianRuns)
    .where(eq(historianRuns.id, runId))
    .limit(1);
  if (!run) return;

  await db
    .update(historianRuns)
    .set({ state: "running" })
    .where(and(eq(historianRuns.id, runId), eq(historianRuns.state, "queued")));

  const pending = await db
    .select({ edgeId: historianRunEdges.edgeId })
    .from(historianRunEdges)
    .where(
      and(
        eq(historianRunEdges.runId, runId),
        drizzleSql`${historianRunEdges.outcome} IS NULL`,
      ),
    );

  const budget = orgBudget(run.orgId, "historian");
  const concurrency = derivedConcurrency();
  const queue = [...pending.map((p) => p.edgeId)];

  let proposed = 0;
  let gaveUp = 0;
  let skipped = 0;

  const worker = async () => {
    for (;;) {
      const edgeId = queue.shift();
      if (edgeId === undefined) return;

      if (await isCancelled(runId)) {
        await recordEdgeOutcome(runId, edgeId, "cancelled");
        continue;
      }

      // Re-check both budgets before every dispatch. When either is spent we
      // stop dispatching and record the rest honestly — never a silent stall,
      // never a run left `running`.
      const [withinRun, headroom] = await Promise.all([
        requestsUsed(runId).then((used) => used < run.requestBudget),
        budget.hasHeadroom(),
      ]);
      if (!withinRun || !headroom) {
        await recordEdgeOutcome(runId, edgeId, "skipped_quota");
        skipped += 1;
        continue;
      }

      const goal = await goalForEdge(run.orgId, edgeId);
      if (!goal) {
        await recordEdgeOutcome(runId, edgeId, "error");
        continue;
      }

      const loopRunId = randomUUID();
      const ctx = {
        orgId: run.orgId,
        edgeId,
        runId: loopRunId,
        seenUrls: new Set<string>(),
        seenContent: new Map<string, string>(),
        stepBudget: config.HISTORIAN_STEP_BUDGET,
        maxParseFailures: config.HISTORIAN_MAX_PARSE_FAILURES,
        signal: hooks.signal,
        budget: {
          hasHeadroom: () => budget.hasHeadroom(),
          record: async (usage: Parameters<typeof budget.record>[0]) => {
            await budget.record(usage);
            await db
              .update(historianRuns)
              .set({ requestsUsed: drizzleSql`${historianRuns.requestsUsed} + 1` })
              .where(eq(historianRuns.id, runId));
          },
        },
        cancelled: async () =>
          (hooks.signal?.aborted ?? false) || (await isCancelled(runId)),
      } satisfies LoopCtx & Record<string, unknown>;

      let outcome: LoopOutcome;
      try {
        outcome = await runLoop(goal, ctx as Parameters<typeof runLoop>[1]);
      } catch (error) {
        outcome = {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      // A loop that hit the wall mid-step is an honest non-answer, not a bug.
      const recorded =
        outcome.kind === "proposed"
          ? "proposed"
          : outcome.kind === "gave_up"
            ? "gave_up"
            : outcome.kind === "cancelled"
              ? "cancelled"
              : "error";
      if (recorded === "proposed") proposed += 1;
      if (recorded === "gave_up") gaveUp += 1;

      await recordEdgeOutcome(runId, edgeId, recorded, loopRunId);
      await hooks.heartbeat?.();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const cancelled = await isCancelled(runId);
  await db
    .update(historianRuns)
    .set({
      state: cancelled ? "cancelled" : "done",
      edgesProposed: proposed,
      edgesGaveUp: gaveUp,
      edgesSkippedQuota: skipped,
      finishedAt: new Date(),
    })
    .where(eq(historianRuns.id, runId));
}

async function requestsUsed(runId: string): Promise<number> {
  const [row] = await db
    .select({ used: historianRuns.requestsUsed })
    .from(historianRuns)
    .where(eq(historianRuns.id, runId))
    .limit(1);
  return row?.used ?? 0;
}

async function isCancelled(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: historianRuns.state })
    .from(historianRuns)
    .where(eq(historianRuns.id, runId))
    .limit(1);
  return row?.state === "cancelled";
}

async function recordEdgeOutcome(
  runId: string,
  edgeId: number,
  outcome: string,
  loopRunId?: string,
): Promise<void> {
  await db
    .update(historianRunEdges)
    .set({ outcome, ...(loopRunId ? { loopRunId } : {}) })
    .where(and(eq(historianRunEdges.runId, runId), eq(historianRunEdges.edgeId, edgeId)));
}

export async function goalForEdge(
  orgId: number,
  edgeId: number,
): Promise<EdgeGoal | null> {
  const [edge] = await db
    .select()
    .from(edgesTable)
    .where(and(eq(edgesTable.id, edgeId), eq(edgesTable.orgId, orgId)))
    .limit(1);
  if (!edge) return null;

  const [src] = await db
    .select()
    .from(nodesTable)
    .where(eq(nodesTable.id, edge.srcId))
    .limit(1);
  const [dst] = await db
    .select()
    .from(nodesTable)
    .where(eq(nodesTable.id, edge.dstId))
    .limit(1);

  return {
    edgeId,
    srcName: src?.name ?? `#${edge.srcId}`,
    dstName: dst?.name ?? `#${edge.dstId}`,
    edgeKind: edge.kind,
  };
}
