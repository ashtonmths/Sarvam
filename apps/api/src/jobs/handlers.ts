import { connectorInstances } from "@sadhak/shared/schema";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { pruneExpiredSessions } from "../auth/session.js";
import { runCrawl } from "../cartographer/index.js";
import { db } from "../db.js";
import { enqueue } from "./queue.js";
import { registerHandler } from "./registry.js";

/**
 * Handlers registered once at boot. Everything long-running in Sadhak is a job
 * — crawls are not requests: they are slow, rate-limited, and failure-prone in
 * someone else's infrastructure.
 */

export function registerJobHandlers(): void {
  /**
   * Self-rescheduling crawl. Re-enqueues itself with jitter on both success
   * and failure, so a connector outage backs off instead of hammering.
   */
  registerHandler(
    "connector.crawl",
    async (payload, ctx) => {
      const instanceId = Number(payload.instanceId);
      const kind = payload.kind === "incremental" ? "incremental" : "full";
      if (!ctx.orgId || !Number.isInteger(instanceId)) {
        throw new Error("connector.crawl requires orgId and instanceId");
      }

      const outcome = await runCrawl(ctx.orgId, instanceId, kind, ctx.signal);

      const [instance] = await db
        .select({
          frequency: connectorInstances.crawlFrequencyMinutes,
          status: connectorInstances.status,
        })
        .from(connectorInstances)
        .where(eq(connectorInstances.id, instanceId))
        .limit(1);

      if (instance && instance.status !== "disabled") {
        // ±10% jitter is the thundering-herd guard when many instances share
        // a frequency.
        const base = instance.frequency * 60_000;
        const jitter = base * (Math.random() * 0.2 - 0.1);
        await enqueue(
          "connector.crawl",
          { instanceId, kind: "full" },
          {
            orgId: ctx.orgId,
            runAfter: new Date(Date.now() + base + jitter),
            dedupeKey: `connector.crawl:${instanceId}`,
            excludeJobId: ctx.jobId,
          },
        );
      }

      if (outcome.state === "failed") {
        throw new Error(outcome.error ?? "crawl failed");
      }
    },
    { timeoutMs: 11 * 60_000, maxAttempts: 3 },
  );

  /** Health probe keeps the settings page honest between crawls. */
  registerHandler("connector.health", async (payload, ctx) => {
    const instanceId = Number(payload.instanceId);
    if (!ctx.orgId || !Number.isInteger(instanceId)) return;
    // Health is derived from the last crawl for now; a live probe lands with
    // the scheduled health job in plan 15's observability work.
    await db
      .update(connectorInstances)
      .set({ updatedAt: new Date() })
      .where(eq(connectorInstances.id, instanceId));
  });

  /** Exhaust, pruned on a schedule. Rationale is never touched by retention. */
  registerHandler("retention.prune_sessions", async () => {
    await pruneExpiredSessions();
  });
}

/**
 * Kick a crawl for every instance that has one due and nothing in flight.
 * Called at boot so a restart re-arms schedules without a cron daemon.
 */
export async function scheduleDueCrawls(): Promise<number> {
  const due = await db
    .select({ id: connectorInstances.id, orgId: connectorInstances.orgId })
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.status, "active"),
        or(
          isNull(connectorInstances.breakerOpenUntil),
          lte(connectorInstances.breakerOpenUntil, new Date()),
        ),
      ),
    );

  let scheduled = 0;
  for (const instance of due) {
    const jobId = await enqueue(
      "connector.crawl",
      { instanceId: instance.id, kind: "full" },
      { orgId: instance.orgId, dedupeKey: `connector.crawl:${instance.id}` },
    );
    if (jobId !== null) scheduled += 1;
  }
  return scheduled;
}
