import { createHash } from "node:crypto";
import { reflexIncidents } from "@sadhak/shared/schema";
import type { BlastRow, ChangeDescriptor, Evidence } from "@sadhak/shared/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordDerivedCheckpoint } from "../changes/checkpoints.js";
import { db } from "../db.js";

/**
 * Everything in Reflex hangs off one row per detected change.
 *
 * Timestamp honesty, inherited by every consumer: `change_at` comes from the
 * **vendor's clock**, so MTTD across clocks is approximate. `detected_at` is
 * our ingress receipt. Polled detection is poll-interval-bound and flagged
 * `detect_path='poll'` — push and poll latencies must never be blended into
 * one headline number.
 *
 * Reflex compensates; it never prevents. No surface built on this table may
 * imply otherwise.
 */

export type IncidentState =
  | "detected"
  | "alerted"
  | "acknowledged"
  | "reverting"
  | "reverted"
  | "revert_failed";

export interface DetectedChange {
  orgId: number;
  connector: string;
  change: ChangeDescriptor;
  vendorEventId: string;
  changeAt: Date | null;
  detectPath: "push" | "poll";
  actor?: { name?: string; email?: string; vendorUserId?: string } | undefined;
  nodeId?: number | null;
}

/**
 * Identity of one detected change, for at-least-once delivery.
 *
 * The components are JSON-encoded rather than joined with a separator. Joining
 * on ":" makes ("airtable:x", "y") and ("airtable", "x:y") the same digest,
 * and two different changes collapsing into one incident means the second is
 * never alerted on — the exact failure Reflex exists to prevent. `externalId`
 * and `vendorEventId` both come from vendor payloads, so the delimiter is not
 * ours to guarantee.
 */
export function dedupeKeyFor(input: {
  connector: string;
  externalId: string;
  operation: string;
  vendorEventId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.connector,
        input.externalId,
        input.operation,
        input.vendorEventId,
      ]),
    )
    .digest("hex");
}

/**
 * At-least-once by construction: vendor retries and our own job retries both
 * land on the unique dedupe key, so a replayed event is one row, not two.
 * Returns null when the incident already existed.
 */
export async function recordDetection(input: DetectedChange): Promise<number | null> {
  const dedupeKey = dedupeKeyFor({
    connector: input.connector,
    externalId: input.change.externalId,
    operation: input.change.operation,
    vendorEventId: input.vendorEventId,
  });

  const [row] = await db
    .insert(reflexIncidents)
    .values({
      orgId: input.orgId,
      dedupeKey,
      connector: input.connector,
      target: input.change.target,
      operation: input.change.operation,
      externalId: input.change.externalId,
      nodeId: input.nodeId ?? null,
      actor: input.actor ?? null,
      detectPath: input.detectPath,
      changeAt: input.changeAt,
      detectedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: reflexIncidents.id });

  return row?.id ?? null;
}

export async function getIncident(orgId: number, id: number) {
  const [row] = await db
    .select()
    .from(reflexIncidents)
    .where(and(eq(reflexIncidents.id, id), eq(reflexIncidents.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Every transition is a single conditional UPDATE, so concurrent job retries
 * cannot double-fire, and every timestamp is written exactly once via COALESCE.
 * Returns false when the row was not in the expected state — which is a
 * no-op, not an error.
 */
async function transition(
  incidentId: number,
  from: IncidentState[],
  to: IncidentState,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const rows = await db
    .update(reflexIncidents)
    .set({ state: to, ...extra })
    .where(and(eq(reflexIncidents.id, incidentId), inArray(reflexIncidents.state, from)))
    .returning({ id: reflexIncidents.id });
  return rows.length > 0;
}

export async function recordVerdict(
  incidentId: number,
  verdictId: string,
  verdict: string,
  blast: BlastRow[],
  evidence: Evidence[],
): Promise<boolean> {
  // A retried job that finds verdict_at set skips straight to alerting.
  const rows = await db
    .update(reflexIncidents)
    .set({ verdictId, verdict, blast, evidence, verdictAt: new Date() })
    .where(
      and(eq(reflexIncidents.id, incidentId), sql`${reflexIncidents.verdictAt} IS NULL`),
    )
    .returning({ id: reflexIncidents.id });
  return rows.length > 0;
}

export async function markAlerted(
  incidentId: number,
  channel: string,
  ts: string,
): Promise<boolean> {
  return transition(incidentId, ["detected"], "alerted", {
    slackChannel: channel,
    slackTs: ts,
    alertedAt: sql`COALESCE(${reflexIncidents.alertedAt}, now())`,
  });
}

export async function markAcknowledged(
  incidentId: number,
  by: string,
  captured: boolean,
): Promise<boolean> {
  return transition(incidentId, ["detected", "alerted"], "acknowledged", {
    acknowledgedBy: by,
    acknowledgedAt: sql`COALESCE(${reflexIncidents.acknowledgedAt}, now())`,
    metadata: sql`${reflexIncidents.metadata} || ${JSON.stringify({ rationaleCaptured: captured })}::jsonb`,
  });
}

/** Claims the incident for a revert — two clicks race safely. */
export async function claimForRevert(incidentId: number, by: string): Promise<boolean> {
  return transition(incidentId, ["detected", "alerted", "revert_failed"], "reverting", {
    revertRequestedBy: by,
    revertRequestedAt: sql`COALESCE(${reflexIncidents.revertRequestedAt}, now())`,
  });
}

export async function markReverted(incidentId: number): Promise<boolean> {
  const reverted = await transition(incidentId, ["reverting"], "reverted", {
    revertedAt: sql`COALESCE(${reflexIncidents.revertedAt}, now())`,
    revertError: null,
  });
  if (!reverted) return false;

  /**
   * A successful revert is the strongest automatic evidence of known-good this
   * system produces: something broke, it was put back, and somebody watched it
   * happen. Recording it means the *next* incident search starts here instead
   * of reaching past a period we already know was repaired.
   *
   * Read back rather than passed in, because only the transition above knows
   * it actually moved — recording a checkpoint for a revert that lost the race
   * would assert health at an instant nobody verified.
   */
  const [row] = await db
    .select({
      orgId: reflexIncidents.orgId,
      externalId: reflexIncidents.externalId,
      connector: reflexIncidents.connector,
      nodeId: reflexIncidents.nodeId,
    })
    .from(reflexIncidents)
    .where(eq(reflexIncidents.id, incidentId))
    .limit(1);

  if (row) {
    await recordDerivedCheckpoint({
      orgId: row.orgId,
      kind: "incident_recovered",
      label: `Reverted ${row.connector} ${row.externalId}`,
      nodeId: row.nodeId,
      evidence: { incidentId },
    });
  }

  return true;
}

export async function markRevertFailed(
  incidentId: number,
  error: string,
): Promise<boolean> {
  // revert_failed stays actionable: the button re-enables as "Retry revert".
  return transition(incidentId, ["reverting"], "revert_failed", { revertError: error });
}
