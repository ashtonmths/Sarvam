import { sql } from "../db.js";

/**
 * Liveness and readiness are different questions, and answering both with one
 * endpoint gets containers killed for the wrong reason.
 *
 * **Liveness** asks "is this process wedged?" A restart is the only cure, so it
 * must not depend on anything a restart cannot fix. If it touched the database,
 * a Postgres blip would kill every API container — turning a recoverable
 * dependency failure into an outage, and restarting containers is precisely
 * what does not help a database under load.
 *
 * **Readiness** asks "should traffic come here?" It touches the database on
 * purpose, and answering 503 takes this container out of rotation while
 * leaving it running.
 */

/** Flipped by the shutdown sequence so the proxy drains us before we close. */
let draining = false;

export function beginDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

export interface ReadinessResult {
  ready: boolean;
  /** Named so a 503 says which probe failed rather than just failing. */
  checks: Record<string, "ok" | "draining" | "failed">;
}

/**
 * A bounded database check. The timeout matters more than the query: a probe
 * that hangs is worse than one that fails, because the orchestrator learns
 * nothing and waits.
 */
export async function readiness(timeoutMs = 2000): Promise<ReadinessResult> {
  if (draining) return { ready: false, checks: { shutdown: "draining" } };

  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db probe timed out")), timeoutMs),
      ),
    ]);
    return { ready: true, checks: { db: "ok" } };
  } catch {
    return { ready: false, checks: { db: "failed" } };
  }
}
