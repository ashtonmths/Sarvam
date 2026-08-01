import { connectorInstances, rationale } from "@sadhak/shared/schema";
import type { ChangeDescriptor } from "@sadhak/shared/types";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { pruneExpiredSessions } from "../auth/session.js";
import { runCrawl } from "../cartographer/index.js";
import { db } from "../db.js";
import { embedAll } from "../embed.js";
import { executeRun } from "../historian/runs.js";
import { purgeStaleCounters } from "../http/rate-limit.js";
import { log } from "../log.js";
import { pollN8nWorkflows } from "../reflex/detect-n8n.js";
import { getIncident, recordVerdict } from "../reflex/incidents.js";
import { rollupDaily } from "../reviewer/rollup.js";
import { runDriftTick } from "../reviewer/run-tick.js";
import { triageFinding } from "../reviewer/triage.js";
import {
  renderUnmappedWarn,
  renderVerdict,
  UnresolvedTargetError,
} from "../sentinel/verdict.js";
import { enqueue } from "./queue.js";
import { registerHandler } from "./registry.js";

/**
 * Handlers registered once at boot. Everything long-running in Sadhak is a job
 * — crawls are not requests, agent loops are not requests, and a verdict for a
 * webhook is not a request: they are slow, rate-limited, and failure-prone in
 * someone else's infrastructure.
 */

/**
 * How many findings one tick may hand to the model. Sized for the free tier,
 * where requests are the metered unit and a call can take tens of seconds.
 */
const TRIAGE_PER_TICK = 5;

export function registerJobHandlers(): void {
  /** Self-rescheduling crawl. Backs off on failure rather than hammering. */
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
    await db
      .update(connectorInstances)
      .set({ updatedAt: new Date() })
      .where(eq(connectorInstances.id, instanceId));
  });

  /**
   * Reflex scoring, on the same deterministic path Modes 1 and 2 call — no
   * Reflex-special logic. The change already happened, so the node is still in
   * the graph until the next crawl removes it: traversal runs on the
   * pre-change graph, which is exactly the blast radius the change had.
   */
  registerHandler(
    "reflex.verdict",
    async (payload, ctx) => {
      const incidentId = Number(payload.incidentId);
      if (!ctx.orgId || !Number.isInteger(incidentId)) return;

      const incident = await getIncident(ctx.orgId, incidentId);
      // A retried job that finds verdict_at set skips straight to alerting.
      if (!incident || incident.verdictAt !== null) return;

      const change = {
        target: incident.target,
        operation: incident.operation,
        connector: incident.connector,
        externalId: incident.externalId,
      } as ChangeDescriptor;

      let result: Awaited<ReturnType<typeof renderVerdict>>;
      try {
        result = await renderVerdict(ctx.orgId, change, { createdBy: "reflex" });
      } catch (error) {
        if (!(error instanceof UnresolvedTargetError)) throw error;
        // A change we cannot score is more suspicious, not less.
        result = await renderUnmappedWarn(ctx.orgId, change, "reflex");
      }

      await recordVerdict(
        incidentId,
        result.id,
        result.verdict,
        result.impacted,
        result.evidence,
      );

      // APPROVE incidents are recorded silently — they still feed the incident
      // feed and the denominator, but a ping for every green change is how
      // Reflex gets muted in week two.
      if (result.verdict !== "APPROVE") {
        await enqueue(
          "reflex.alert",
          { incidentId },
          { orgId: ctx.orgId, dedupeKey: `reflex.alert:${incidentId}`, priority: 5 },
        );
      }
    },
    { timeoutMs: 60_000, maxAttempts: 3 },
  );

  /**
   * Reflex without Slack degrades to a feed, never to silence: the incident
   * row and every timestamp are complete regardless of whether this succeeds.
   */
  registerHandler("reflex.alert", async (payload, ctx) => {
    const incidentId = Number(payload.incidentId);
    if (!ctx.orgId || !Number.isInteger(incidentId)) return;
    const { postIncidentAlert } = await import("../reflex/slack.js");
    await postIncidentAlert(ctx.orgId, incidentId);
  });

  /**
   * The revert. Two retries with backoff, deliberately few: write operations
   * must not flap against a system a human may be concurrently fixing.
   */
  registerHandler(
    "reflex.revert",
    async (payload, ctx) => {
      const incidentId = Number(payload.incidentId);
      if (!ctx.orgId || !Number.isInteger(incidentId)) return;

      const incident = await getIncident(ctx.orgId, incidentId);
      if (!incident) return;

      const { execute } = await import("../reflex/revert/index.js");
      const { escalateRevertFailure, updateAlert } = await import("../reflex/slack.js");
      const { markRevertFailed, markReverted } = await import("../reflex/incidents.js");

      const outcome = await execute(incident);

      if (outcome.ok) {
        await markReverted(incidentId);
        await updateAlert(
          ctx.orgId,
          incidentId,
          `✅ Reverted by ${incident.revertRequestedBy ?? "an operator"} — ${outcome.detail}`,
        );
        return;
      }

      // On the final attempt, escalate in-thread with the vendor error
      // verbatim and the connector's inline recovery action.
      if (ctx.attempt >= 2) {
        await markRevertFailed(incidentId, outcome.error);
        await escalateRevertFailure(ctx.orgId, incidentId, outcome.error);
        return;
      }
      throw new Error(outcome.error);
    },
    { timeoutMs: 60_000, maxAttempts: 2 },
  );

  /** Poll path for n8n: interval-bound, and flagged `poll` everywhere. */
  registerHandler("reflex.poll_n8n", async (_payload, ctx) => {
    if (!ctx.orgId) return;
    await pollN8nWorkflows(ctx.orgId);
    await enqueue(
      "reflex.poll_n8n",
      {},
      {
        orgId: ctx.orgId,
        runAfter: new Date(Date.now() + 30_000),
        dedupeKey: `reflex.poll_n8n:${ctx.orgId}`,
        excludeJobId: ctx.jobId,
      },
    );
  });

  /**
   * The hard gate. All verdict work happens here, never in the webhook
   * handler, so GitHub always gets its 200 inside the 10-second budget.
   */
  registerHandler(
    "github.check",
    async (payload) => {
      const installationId = Number(payload.installationId);
      const repo = String(payload.repo ?? "");
      const prNumber = Number(payload.prNumber);
      const headSha = String(payload.headSha ?? "");
      if (!installationId || !repo || !prNumber || !headSha) return;

      const { orgForInstallation, runCheck } = await import("../github/checks.js");
      const orgId = await orgForInstallation(installationId);
      // A decision from an uninstalled or unlinked org must be impossible.
      if (orgId === null) return;

      await runCheck({
        orgId,
        installationId,
        repo,
        prNumber,
        headSha,
        baseSha: String(payload.baseSha ?? ""),
      });
    },
    { timeoutMs: 5 * 60_000, maxAttempts: 2 },
  );

  /** Airtable pings carry no payload — this is the cursor-based pull. */
  registerHandler("webhook.fetch_payloads", async (payload, ctx) => {
    const instanceId = Number(payload.instanceId);
    if (!ctx.orgId || !Number.isInteger(instanceId)) return;
    const { fetchAirtablePayloads } = await import("../reflex/airtable-webhooks.js");
    await fetchAirtablePayloads(ctx.orgId, instanceId);
  });

  /**
   * Silent expiry is the failure mode that turns Reflex into a product that
   * quietly stopped working, so this runs daily whether or not anything is due.
   */
  registerHandler("reflex.refresh_airtable_webhooks", async (_payload, ctx) => {
    if (!ctx.orgId) return;
    const { refreshAirtableWebhooks } = await import("../reflex/airtable-webhooks.js");
    await refreshAirtableWebhooks(ctx.orgId);
    await enqueue(
      "reflex.refresh_airtable_webhooks",
      {},
      {
        orgId: ctx.orgId,
        runAfter: new Date(Date.now() + 24 * 60 * 60_000),
        dedupeKey: `reflex.refresh_airtable:${ctx.orgId}`,
        excludeJobId: ctx.jobId,
      },
    );
  });

  /** The n8n push path: same normalization as the poll, better latency. */
  registerHandler("reflex.n8n_push", async (payload, ctx) => {
    const instanceId = Number(payload.instanceId);
    if (!ctx.orgId || !Number.isInteger(instanceId)) return;
    // The hook tells us *that* something changed; the poll logic works out
    // what, from the same snapshot comparison, so there is one code path.
    await pollN8nWorkflows(ctx.orgId);
  });

  /** The agent fan-out, as one cancellable, heartbeated unit of work. */
  registerHandler(
    "historian.run",
    async (payload, ctx) => {
      const runId = String(payload.runId ?? "");
      if (!runId) return;
      await executeRun(runId, { heartbeat: ctx.heartbeat, signal: ctx.signal });
    },
    { timeoutMs: 30 * 60_000, maxAttempts: 1 },
  );

  /**
   * All embedding computation lives here. Every producer inserts with a null
   * embedding and enqueues, so the request path never touches transformers.js
   * and gate latency cannot regress behind a batch.
   */
  registerHandler("rationale.embed", async () => {
    const pending = await db
      .select({ id: rationale.id, body: rationale.body })
      .from(rationale)
      .where(isNull(rationale.embedding))
      .limit(16);
    if (pending.length === 0) return;

    const vectors = await embedAll(pending.map((r) => r.body));
    for (const [index, row] of pending.entries()) {
      const vector = vectors[index];
      if (!vector) continue;
      await db
        .update(rationale)
        .set({ embedding: vector })
        .where(eq(rationale.id, row.id));
    }

    // More may have arrived while this batch ran.
    if (pending.length === 16) {
      await enqueue("rationale.embed", {}, { dedupeKey: "rationale.embed" });
    }
  });

  /**
   * The drift gate, self-rescheduling like the other pollers. Runs whether or
   * not the model quota is spent: detection is deterministic, and a drift
   * detector that goes blind when the quota runs out goes blind exactly when a
   * busy day made it matter.
   */
  registerHandler(
    "reviewer.tick",
    async (payload, ctx) => {
      const instanceId = Number(payload.instanceId);
      if (!ctx.orgId || !Number.isInteger(instanceId)) return;

      try {
        const outcome = await runDriftTick(ctx.orgId, instanceId, ctx.signal);
        /**
         * Triage is queued per finding rather than run inline: it is the only
         * part of this loop that spends model requests, and it must not be
         * able to make a detection tick fail or run long.
         *
         * Capped, because a single migration can rename thirty columns at
         * once and queueing thirty model calls would spend a free-tier day on
         * one deploy. The rest stay open for a human, which is the same place
         * an exhausted quota leaves them — there is no state where a finding
         * is silently dropped for want of triage.
         */
        const queued = outcome.openedIds.slice(0, TRIAGE_PER_TICK);
        if (outcome.openedIds.length > queued.length) {
          log().info({
            event: "triage_capped",
            connectorInstanceId: instanceId,
            opened: outcome.openedIds.length,
            queued: queued.length,
          });
        }
        for (const findingId of queued) {
          await enqueue(
            "reviewer.triage",
            { findingId },
            {
              orgId: ctx.orgId,
              dedupeKey: `reviewer.triage:${findingId}`,
              priority: -5,
            },
          );
        }
      } finally {
        // Rescheduled in a finally: a tick that failed against a flaky
        // provider must not silently stop watching that instance forever.
        await enqueue(
          "reviewer.tick",
          { instanceId },
          {
            orgId: ctx.orgId,
            runAfter: new Date(Date.now() + 10 * 60_000),
            dedupeKey: `reviewer.tick:${instanceId}`,
            excludeJobId: ctx.jobId,
          },
        );
      }
    },
    { timeoutMs: 5 * 60_000, maxAttempts: 2 },
  );

  /**
   * Triage one finding. Deliberately not retried: the failure modes are an
   * exhausted quota and a model that will not produce a parseable judgment,
   * and neither is fixed by trying twice. Both leave the finding open with
   * budget_exhausted_at stamped, which is a human's cue rather than a mute.
   */
  registerHandler(
    "reviewer.triage",
    async (payload, ctx) => {
      const findingId = Number(payload.findingId);
      if (!ctx.orgId || !Number.isInteger(findingId)) return;
      await triageFinding(ctx.orgId, findingId);
    },
    { timeoutMs: 120_000, maxAttempts: 1 },
  );

  /**
   * Nightly metric snapshots. Recomputes a trailing window rather than
   * appending one day, so a late-arriving webhook self-heals instead of
   * leaving a permanently wrong point on the chart.
   */
  registerHandler("metrics.rollup_daily", async (_payload, ctx) => {
    if (!ctx.orgId) return;
    await rollupDaily(ctx.orgId);
    await enqueue(
      "metrics.rollup_daily",
      {},
      {
        orgId: ctx.orgId,
        runAfter: new Date(Date.now() + 24 * 60 * 60_000),
        dedupeKey: `metrics.rollup_daily:${ctx.orgId}`,
        excludeJobId: ctx.jobId,
      },
    );
  });

  /** Exhaust, pruned on a schedule. Rationale is never touched by retention. */
  registerHandler("retention.prune_sessions", async () => {
    await pruneExpiredSessions();
    // Rate counters age out with the same sweep: a closed window is only ever
    // read by the request that closed it, so anything older is dead rows.
    await purgeStaleCounters();
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

/** Re-arms the n8n poll for every org with an n8n instance connected. */
export async function scheduleReflexPolling(): Promise<number> {
  const instances = await db
    .select({ orgId: connectorInstances.orgId })
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.connector, "n8n"),
        eq(connectorInstances.status, "active"),
      ),
    );

  const orgs = [...new Set(instances.map((i) => i.orgId))];
  let scheduled = 0;
  for (const orgId of orgs) {
    const jobId = await enqueue(
      "reflex.poll_n8n",
      {},
      { orgId, dedupeKey: `reflex.poll_n8n:${orgId}` },
    );
    if (jobId !== null) scheduled += 1;
  }
  return scheduled;
}
