import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { sqlJobs } from "../db.js";
import { log, withLogContext } from "../log.js";
import { jobsProcessed } from "../metrics.js";
import { settleAfterFailure } from "./backoff.js";
import { getHandler, type JobContext } from "./registry.js";

/**
 * The SKIP LOCKED worker. Runs in-process with the API by default; when
 * embedding or crawl CPU measurably degrades gate latency, the same image runs
 * as a second compose service with JOBS_ENABLED on and the HTTP server off —
 * no code change, one compose entry.
 */

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
const HEARTBEAT_MS = 30_000;
/** A worker that died mid-job is reaped after this many minutes. */
const VISIBILITY_TIMEOUT = "5 minutes";

let running = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const inFlight = new Set<Promise<void>>();

export const metrics = {
  claimed: 0,
  succeeded: 0,
  retried: 0,
  deadLettered: 0,
};

/**
 * A claimed job. This is a raw postgres.js query rather than Drizzle because
 * `FOR UPDATE SKIP LOCKED` is the whole point — so the columns come back
 * snake_cased and are mapped explicitly here. Reading `job.orgId` off the raw
 * row silently yields undefined, which is a bug that only shows up as a
 * handler failing on an org it was definitely given.
 */
interface ClaimedJob {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  orgId: number | null;
  attempts: number;
  maxAttempts: number;
}

interface RawJobRow {
  id: string | number;
  kind: string;
  payload: Record<string, unknown> | null;
  org_id: string | number | null;
  attempts: number;
  max_attempts: number;
}

async function claim(limit: number): Promise<ClaimedJob[]> {
  const rows = (await sqlJobs`
    UPDATE jobs SET state = 'running',
                    attempts = attempts + 1,
                    locked_by = ${WORKER_ID},
                    locked_at = now(),
                    heartbeat_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE state = 'queued' AND run_after <= now()
      ORDER BY priority DESC, run_after
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, payload, org_id, attempts, max_attempts
  `) as unknown as RawJobRow[];

  return rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind,
    payload: row.payload ?? {},
    orgId: row.org_id === null ? null : Number(row.org_id),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

/** Requeue jobs whose worker stopped heartbeating; dead-letter if exhausted. */
async function reap(): Promise<void> {
  await sqlJobs`
    UPDATE jobs
    SET state = CASE WHEN attempts >= max_attempts THEN 'dead_letter'::job_state
                     ELSE 'queued'::job_state END,
        last_error = coalesce(last_error, 'worker died mid-job (reaped)'),
        locked_by = NULL,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
    WHERE state = 'running'
      AND heartbeat_at < now() - ${VISIBILITY_TIMEOUT}::interval
  `;
}

async function runOne(job: ClaimedJob): Promise<void> {
  // Same ambient context as a request, so a crawl that fails deep inside a
  // connector is as traceable as an HTTP 500 — and a job enqueued by a request
  // is not orphaned from the request that caused it.
  return withLogContext(
    { jobId: job.id, ...(job.orgId === null ? {} : { orgId: job.orgId }) },
    () => runOneInContext(job, getHandler(job.kind)),
  );
}

async function runOneInContext(
  job: ClaimedJob,
  registration: ReturnType<typeof getHandler>,
): Promise<void> {
  metrics.claimed += 1;

  if (!registration) {
    await sqlJobs`
      UPDATE jobs SET state = 'dead_letter', last_error = ${`no handler registered for kind "${job.kind}"`},
                      finished_at = now()
      WHERE id = ${job.id}
    `;
    metrics.deadLettered += 1;
    jobsProcessed.inc({ kind: job.kind, outcome: "dead_letter" });
    return;
  }

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    /**
     * Caught, because an unhandled rejection here kills the process.
     *
     * `void` discards the promise but not its rejection, so a transient
     * database blip during a long crawl became an unhandled rejection — which
     * on Node's default terminates the worker mid-job. A missed heartbeat is
     * survivable: the reaper only requeues after several are missed, and the
     * next tick writes one anyway.
     */
    void sqlJobs`UPDATE jobs SET heartbeat_at = now() WHERE id = ${job.id}`.catch(
      (error: unknown) => {
        log().warn({
          event: "job_heartbeat_failed",
          jobId: job.id,
          err: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, HEARTBEAT_MS);

  const timeoutMs = registration.options.timeoutMs ?? 10 * 60_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const ctx: JobContext = {
    jobId: job.id,
    orgId: job.orgId,
    attempt: job.attempts,
    heartbeat: async () => {
      await sqlJobs`UPDATE jobs SET heartbeat_at = now() WHERE id = ${job.id}`;
    },
    signal: controller.signal,
  };

  try {
    await registration.fn(job.payload, ctx);
    await sqlJobs`
      UPDATE jobs SET state = 'done', finished_at = now(), last_error = NULL
      WHERE id = ${job.id}
    `;
    metrics.succeeded += 1;
    jobsProcessed.inc({ kind: job.kind, outcome: "succeeded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = registration.options.maxAttempts ?? job.maxAttempts;
    const settle = settleAfterFailure(job.attempts, maxAttempts);

    if (settle.state === "dead_letter") {
      await sqlJobs`
        UPDATE jobs SET state = 'dead_letter', last_error = ${message}, finished_at = now()
        WHERE id = ${job.id}
      `;
      metrics.deadLettered += 1;
      jobsProcessed.inc({ kind: job.kind, outcome: "dead_letter" });
    } else {
      await sqlJobs`
        UPDATE jobs SET state = 'queued',
                        last_error = ${message},
                        run_after = now() + ${`${Math.round(settle.runAfterMs / 1000)} seconds`}::interval,
                        locked_by = NULL
        WHERE id = ${job.id}
      `;
      metrics.retried += 1;
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    await reap();
    const capacity = config.JOBS_CONCURRENCY - inFlight.size;
    if (capacity <= 0) return;

    const claimed = await claim(capacity);
    for (const job of claimed) {
      const promise = runOne(job).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }
  } catch (error) {
    log().error({ event: "job_tick_failed", err: error }, "jobs: tick failed");
  }
}

function schedule(): void {
  timer = setTimeout(async () => {
    await tick();
    if (!stopping) schedule();
  }, config.JOBS_POLL_MS);
}

export function startWorker(): void {
  if (running || !config.JOBS_ENABLED) return;
  running = true;
  stopping = false;
  log().info(
    {
      event: "worker_started",
      workerId: WORKER_ID,
      concurrency: config.JOBS_CONCURRENCY,
    },
    "jobs: worker started",
  );
  void tick().then(schedule);
}

/** Stop claiming, let in-flight handlers finish, then abort what remains. */
export async function stopWorker(): Promise<void> {
  if (!running) return;
  stopping = true;
  if (timer) clearTimeout(timer);

  const deadline = new Promise<void>((resolve) =>
    setTimeout(resolve, config.JOBS_DRAIN_TIMEOUT_MS),
  );
  await Promise.race([Promise.allSettled([...inFlight]), deadline]);
  running = false;
}
