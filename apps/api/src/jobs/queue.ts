import { jobs } from "@sadhak/shared/schema";
import { and, eq, inArray, ne, sql as raw } from "drizzle-orm";
import { dbJobs } from "../db.js";

export interface EnqueueOptions {
  orgId?: number | null;
  runAfter?: Date;
  /** Idempotent enqueue: a queued/running job with this key is not duplicated. */
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
  /**
   * Ignore this job when checking the dedupe key. A self-rescheduling handler
   * is itself `running` under the same key while it re-enqueues, and without
   * this it would dedupe against itself and silently stop recurring.
   */
  excludeJobId?: number;
}

/**
 * Returns the job id, or null when a dedupe key matched an in-flight job —
 * which is a success, not a failure: the work is already scheduled.
 */
export async function enqueue(
  kind: string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<number | null> {
  if (options.dedupeKey) {
    const conditions = [
      eq(jobs.dedupeKey, options.dedupeKey),
      inArray(jobs.state, ["queued", "running"]),
    ];
    if (options.excludeJobId !== undefined) {
      conditions.push(ne(jobs.id, options.excludeJobId));
    }

    const existing = await dbJobs
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(...conditions))
      .limit(1);
    if (existing.length > 0) return null;
  }

  try {
    const [row] = await dbJobs
      .insert(jobs)
      .values({
        kind,
        payload,
        orgId: options.orgId ?? null,
        runAfter: options.runAfter ?? new Date(),
        dedupeKey: options.dedupeKey ?? null,
        priority: options.priority ?? 0,
        maxAttempts: options.maxAttempts ?? 5,
      })
      .returning({ id: jobs.id });

    return row?.id ?? null;
  } catch (error) {
    /**
     * Losing the race is the dedupe working, not a failure.
     *
     * The check above is a SELECT followed by an INSERT, so two callers can
     * both find nothing and both insert — two API replicas booting, or a
     * manual trigger racing a self-reschedule. A partial unique index on
     * queued rows is what actually enforces it, and this turns the violation
     * it raises back into the "already queued" answer the caller expects.
     */
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/** Postgres 23505, however the driver happens to wrap it. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return true;
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}

export interface QueueStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  deadLetter: number;
  oldestQueuedAgeSeconds: number | null;
}

export async function queueStats(): Promise<QueueStats> {
  const rows = await dbJobs
    .select({ state: jobs.state, count: raw<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.state);

  const byState = new Map(rows.map((r) => [r.state, r.count]));

  const [oldest] = await dbJobs
    .select({
      age: raw<number | null>`extract(epoch from (now() - min(${jobs.runAfter})))::int`,
    })
    .from(jobs)
    .where(eq(jobs.state, "queued"));

  return {
    queued: byState.get("queued") ?? 0,
    running: byState.get("running") ?? 0,
    done: byState.get("done") ?? 0,
    failed: byState.get("failed") ?? 0,
    deadLetter: byState.get("dead_letter") ?? 0,
    oldestQueuedAgeSeconds: oldest?.age ?? null,
  };
}
