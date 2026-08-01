import {
  connectorInstances,
  n8nExecutionFailures,
  nodes as nodesTable,
} from "@sadhak/shared/schema";
import { and, eq, max } from "drizzle-orm";
import { baseUrlFor, egressOptionsFor } from "../connectors/registry.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { getReadCredential } from "../vault/vault.js";
import { listErrorExecutions, type N8nErrorExecution } from "./admin.js";

/**
 * Failed workflow executions, detected by polling.
 *
 * n8n's public API has no outbound hook for "an execution failed" — the only
 * push path it offers is an error *workflow*, which has to be written into
 * every account and pointed at a callback we can reach. So this is the poll
 * path, and everything it writes is flagged `detect_path='poll'` for the same
 * reason Reflex does it: a push latency and a poll latency must never be
 * averaged into one number.
 *
 * It reads with the *org's* credential, never the platform owner key. See the
 * note in provision.ts — an owner key cannot be scoped to one tenant on a
 * community licence, so polling with it would file every tenant's failures
 * against whichever org happened to be polled.
 */

/** Bounded so one instance with a long failure history cannot hold the poll. */
const MAX_POLL_PAGES = 20;

/**
 * A vendor timestamp that cannot be trusted to parse.
 *
 * Identical reasoning to the workflow poll: `new Date("garbage")` is an
 * Invalid Date, drizzle serialises it by calling `toISOString()`, and that
 * throws a RangeError which escapes before the job re-enqueues itself — one
 * malformed timestamp would stop failure detection for that org permanently.
 * A zone-less string is rejected rather than silently read in whatever zone
 * the container happens to be configured for.
 */
function parseVendorDate(raw: string | null): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw.trim())) return null;
  return parsed;
}

/**
 * The highest execution id already recorded for this instance.
 *
 * n8n hands executions back newest-first with monotonic ids, so this is what
 * keeps a steady-state poll to a single page instead of re-reading the whole
 * failure history every thirty seconds. Only failures are stored, but only
 * failures are ever fetched, so the mark is exact for this query.
 */
async function highWaterMark(instanceId: number): Promise<number> {
  const [row] = await db
    .select({ value: max(n8nExecutionFailures.executionId) })
    .from(n8nExecutionFailures)
    .where(eq(n8nExecutionFailures.instanceId, instanceId));
  return row?.value ?? 0;
}

export async function pollN8nExecutionFailures(orgId: number): Promise<number> {
  const instances = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, "n8n"),
        eq(connectorInstances.status, "active"),
      ),
    );

  let recorded = 0;

  for (const instance of instances) {
    // No credential means the connector was provisioned but never completed.
    // That is the normal state of a freshly signed-up workspace, not a fault.
    const secret = await getReadCredential(orgId, instance.id, "n8n.poll_executions");
    if (!secret) continue;

    const afterId = await highWaterMark(instance.id);

    let failures: N8nErrorExecution[];
    try {
      failures = await listErrorExecutions(
        {
          baseUrl: baseUrlFor(instance),
          apiKey: secret.reveal(),
          egress: egressOptionsFor(instance),
        },
        { afterId, maxPages: MAX_POLL_PAGES },
      );
    } catch (error) {
      // One unreachable instance must not stop the others, and must not stop
      // the job re-enqueueing itself.
      log().warn(
        {
          event: "n8n_execution_poll_failed",
          orgId,
          instanceId: instance.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "n8n: execution poll failed",
      );
      continue;
    }

    for (const failure of failures) {
      const nodeId = await graphNodeFor(orgId, failure.workflowId);

      const [inserted] = await db
        .insert(n8nExecutionFailures)
        .values({
          orgId,
          instanceId: instance.id,
          executionId: failure.id,
          workflowId: failure.workflowId,
          workflowName: failure.workflowName,
          nodeId,
          mode: failure.mode,
          failedNode: failure.failedNode,
          errorMessage: failure.errorMessage,
          startedAt: parseVendorDate(failure.startedAt),
          stoppedAt: parseVendorDate(failure.stoppedAt),
          detectPath: "poll",
        })
        // At-least-once delivery plus a poll that overlaps its own window
        // means the same execution arrives more than once. The unique
        // constraint is the actual guarantee; this makes the redelivery
        // silent instead of an error.
        .onConflictDoNothing({
          target: [n8nExecutionFailures.instanceId, n8nExecutionFailures.executionId],
        })
        .returning({ id: n8nExecutionFailures.id });

      if (inserted) recorded += 1;
    }
  }

  return recorded;
}

/**
 * The graph node for a workflow, when the crawl has already seen it.
 *
 * Nullable on purpose: a workflow can fail before it has ever been crawled,
 * and refusing to record that failure until the graph catches up would lose
 * exactly the failures that happen right after someone builds something.
 */
async function graphNodeFor(orgId: number, workflowId: string): Promise<number | null> {
  if (!workflowId) return null;

  const [node] = await db
    .select({ id: nodesTable.id })
    .from(nodesTable)
    .where(
      and(
        eq(nodesTable.orgId, orgId),
        eq(nodesTable.connector, "n8n"),
        eq(nodesTable.externalId, `workflow/${workflowId}`),
      ),
    )
    .limit(1);

  return node?.id ?? null;
}

export const __testing = { parseVendorDate };
