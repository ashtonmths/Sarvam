import { checkpoints } from "@sadhak/shared/schema";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db.js";

/**
 * Checkpoints: moments the system is believed to have been healthy.
 *
 * The point of recording them is to make the *first* investigation window
 * small. Searching all of history for the cause of an incident is both slow
 * and inaccurate — the further back it reaches, the more plausible-looking
 * changes it finds that had nothing to do with anything. Starting at the most
 * recent trusted point and widening only on failure inverts that: the cheapest
 * search runs first, and cost is paid only when it was actually needed.
 */

export type CheckpointKind =
  | "manual"
  | "gate_approved"
  | "crawl_healthy"
  | "incident_recovered"
  | "release";

/**
 * How much each kind is trusted as evidence that things were working.
 *
 * These are not equal claims. A human asserting "deployed and verified" has
 * checked something; a crawl completing without error only means the connector
 * answered. Ranking them wrong costs a wasted round of investigation, never a
 * wrong answer, because every window is still searched on its own evidence.
 */
export const KIND_CONFIDENCE: Record<CheckpointKind, number> = {
  manual: 0.95,
  release: 0.85,
  incident_recovered: 0.7,
  gate_approved: 0.6,
  crawl_healthy: 0.4,
};

export interface CheckpointRow {
  id: number;
  kind: CheckpointKind;
  label: string;
  confidence: number;
  occurredAt: Date;
  repoId: number | null;
  nodeId: number | null;
  environment: string | null;
  sourceUrl: string | null;
}

export async function recordCheckpoint(input: {
  orgId: number;
  kind: CheckpointKind;
  label: string;
  occurredAt: Date;
  repoId?: number | null;
  nodeId?: number | null;
  environment?: string | null;
  sourceUrl?: string | null;
  confidence?: number;
  evidence?: Record<string, unknown>;
  createdBy?: string;
}): Promise<number> {
  const [row] = await db
    .insert(checkpoints)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      label: input.label,
      occurredAt: input.occurredAt,
      repoId: input.repoId ?? null,
      nodeId: input.nodeId ?? null,
      environment: input.environment ?? null,
      sourceUrl: input.sourceUrl ?? null,
      confidence: input.confidence ?? KIND_CONFIDENCE[input.kind],
      evidence: input.evidence ?? {},
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: checkpoints.id });

  if (!row) throw new Error("failed to record checkpoint");
  return row.id;
}

/**
 * Candidate checkpoints before an instant, best first.
 *
 * "Best" is recency weighted by trust, not recency alone: a crawl that
 * happened to finish two minutes before the incident says far less than a
 * human marking a release healthy an hour earlier, and starting from the crawl
 * would open a window too narrow to contain the cause.
 *
 * A checkpoint scoped to a repository or node is preferred over an org-wide
 * one, since a narrower scope is a more specific claim — but org-wide ones are
 * still returned, because an org that has only ever recorded those should get
 * an investigation rather than an empty result.
 */
export async function candidatesBefore(
  orgId: number,
  before: Date,
  scope: { repoId?: number | null; nodeId?: number | null } = {},
  limit = 10,
): Promise<CheckpointRow[]> {
  const filters = [eq(checkpoints.orgId, orgId), lt(checkpoints.occurredAt, before)];

  // Scoped-to-this-repo or unscoped. A checkpoint for a *different* repo says
  // nothing about this one, so it is excluded rather than ranked low.
  if (scope.repoId != null) {
    filters.push(
      or(eq(checkpoints.repoId, scope.repoId), isNull(checkpoints.repoId)) as never,
    );
  }
  if (scope.nodeId != null) {
    filters.push(
      or(eq(checkpoints.nodeId, scope.nodeId), isNull(checkpoints.nodeId)) as never,
    );
  }

  const rows = await db
    .select({
      id: checkpoints.id,
      kind: checkpoints.kind,
      label: checkpoints.label,
      confidence: checkpoints.confidence,
      occurredAt: checkpoints.occurredAt,
      repoId: checkpoints.repoId,
      nodeId: checkpoints.nodeId,
      environment: checkpoints.environment,
      sourceUrl: checkpoints.sourceUrl,
    })
    .from(checkpoints)
    .where(and(...filters))
    /**
     * Ranked in SQL so the ordering is one indexed pass rather than a fetch of
     * every historical checkpoint into memory. Specificity first, then trust
     * decayed by age: a checkpoint loses half its weight roughly every three
     * days, so an old but highly trusted point still beats a fresh weak one
     * without ever beating a fresh strong one.
     */
    .orderBy(
      sql`(${checkpoints.repoId} IS NOT NULL OR ${checkpoints.nodeId} IS NOT NULL) DESC`,
      sql`${checkpoints.confidence} * exp(-extract(epoch FROM (${before.toISOString()}::timestamptz - ${checkpoints.occurredAt})) / 259200.0) DESC`,
      desc(checkpoints.occurredAt),
    )
    .limit(limit);

  return rows as CheckpointRow[];
}

/**
 * The window a checkpoint opens, in order of widening.
 *
 * Each successive checkpoint reaches further back, so the returned windows all
 * end at the incident and begin progressively earlier. The caller searches
 * them in order and stops at the first that explains the incident.
 *
 * When an org has no checkpoints at all, one synthetic window is returned —
 * a fixed lookback — so the investigation degrades to "search recent history"
 * rather than refusing to run. That fallback is labelled, so the answer can
 * say it was searching blind.
 */
export const FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface Window {
  from: Date;
  to: Date;
  checkpoint: CheckpointRow | null;
  /** Why this window, in one phrase, for the final report. */
  reason: string;
}

export function windowsFrom(
  candidates: CheckpointRow[],
  incidentAt: Date,
  maxWindows: number,
): Window[] {
  if (candidates.length === 0) {
    return [
      {
        from: new Date(incidentAt.getTime() - FALLBACK_LOOKBACK_MS),
        to: incidentAt,
        checkpoint: null,
        reason:
          "No checkpoint has been recorded, so this is a fixed 24-hour lookback rather than a known-good starting point.",
      },
    ];
  }

  // Widening order, so each round searches strictly more than the last.
  const ordered = [...candidates].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );

  if (ordered.length <= maxWindows) return ordered.map((c) => toWindow(c, incidentAt));

  /**
   * Spread across the whole candidate range rather than taking the newest few.
   *
   * Taking the first N gave a ladder whose widest rung was still recent — on a
   * deployment that checkpoints often, four windows spanning a couple of hours
   * between them. Widening has to actually widen, so the rungs are sampled
   * evenly and the *oldest* candidate is always the last one, which makes the
   * final round the broadest search available rather than the fourth-narrowest.
   */
  const picked: CheckpointRow[] = [];
  /**
   * Guarded, because `maxWindows` of 1 is valid input — the API accepts it and
   * it means "search only the narrowest window". Dividing by `maxWindows - 1`
   * gave Infinity, `Math.round(0 * Infinity)` is NaN, the index lookup was
   * undefined, and the ladder came back empty. `investigate` then found no
   * rounds and reported "no change was recorded in any window searched",
   * having searched none — a confident negative from a search that never ran.
   */
  const step = maxWindows > 1 ? (ordered.length - 1) / (maxWindows - 1) : 0;
  for (let i = 0; i < maxWindows; i += 1) {
    const chosen = ordered[Math.round(i * step)];
    // Rounding can land twice on one index at small pool sizes.
    if (chosen && !picked.includes(chosen)) picked.push(chosen);
  }

  return picked.map((c) => toWindow(c, incidentAt));
}

function toWindow(checkpoint: CheckpointRow, incidentAt: Date): Window {
  return {
    from: checkpoint.occurredAt,
    to: incidentAt,
    checkpoint,
    reason: `Since ${checkpoint.kind.replace(/_/g, " ")}: ${checkpoint.label}`,
  };
}

/**
 * Records a checkpoint from a signal the system already produces.
 *
 * Without this, checkpoints only exist where somebody remembered to press a
 * button — and an investigation on a fresh install would have nothing to
 * narrow with, which is exactly when it is most needed. A recovered incident
 * and a completed crawl are both weak-but-real evidence that things worked at
 * that instant, so they are recorded at a confidence that says so.
 *
 * Best-effort by construction: a checkpoint that fails to write must never
 * fail the thing that produced it. Losing one costs a slightly wider search.
 */
export async function recordDerivedCheckpoint(input: {
  orgId: number;
  kind: CheckpointKind;
  label: string;
  occurredAt?: Date;
  nodeId?: number | null;
  sourceUrl?: string | null;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordCheckpoint({
      orgId: input.orgId,
      kind: input.kind,
      label: input.label,
      occurredAt: input.occurredAt ?? new Date(),
      nodeId: input.nodeId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      evidence: input.evidence ?? {},
      createdBy: "system",
    });
  } catch {
    /* a missing checkpoint widens a future search; it breaks nothing */
  }
}

export async function listCheckpoints(
  orgId: number,
  limit = 50,
): Promise<CheckpointRow[]> {
  const rows = await db
    .select({
      id: checkpoints.id,
      kind: checkpoints.kind,
      label: checkpoints.label,
      confidence: checkpoints.confidence,
      occurredAt: checkpoints.occurredAt,
      repoId: checkpoints.repoId,
      nodeId: checkpoints.nodeId,
      environment: checkpoints.environment,
      sourceUrl: checkpoints.sourceUrl,
    })
    .from(checkpoints)
    .where(eq(checkpoints.orgId, orgId))
    .orderBy(desc(checkpoints.occurredAt))
    .limit(limit);

  return rows as CheckpointRow[];
}
