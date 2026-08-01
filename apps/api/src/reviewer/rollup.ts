import { metricRollups } from "@sadhak/shared/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, sql } from "../db.js";
import { log } from "../log.js";

/**
 * Daily metric snapshots.
 *
 * Two reasons the series is stored rather than recomputed on read. A dashboard
 * that re-aggregates every incident on every page load gets slower exactly as a
 * customer gets more valuable; and the event tables are pruned by retention, so
 * a series computed from them would silently rewrite its own history as old
 * rows aged out.
 *
 * Recomputed over a trailing window rather than appended once. Every input is
 * an immutable event table, so re-running is safe and a late-arriving webhook
 * self-heals on the next pass instead of leaving one permanently wrong day.
 * That property is also what makes a backfill and a nightly run the same code.
 */

/** How many days back each run recomputes. Long enough for a late webhook. */
const TRAILING_DAYS = 7;

export interface RollupResult {
  days: number;
  rows: number;
}

/**
 * Facts per day, each an event count or a timestamp delta. Nothing here is
 * self-reported by a model, and nothing improves when the product degrades.
 */
async function rollupDay(orgId: number, day: string): Promise<number> {
  const rows: Array<{ metric: string; value: number; meta?: Record<string, unknown> }> =
    [];

  const [gate] = await sql<{ blocked: number; warned: number; approved: number }[]>`
    SELECT
      count(*) FILTER (WHERE v.verdict = 'BLOCK')::int   AS blocked,
      count(*) FILTER (WHERE v.verdict = 'WARN')::int    AS warned,
      count(*) FILTER (WHERE v.verdict = 'APPROVE')::int AS approved
    FROM gate_decisions gd
    JOIN verdicts v ON v.id = gd.verdict_id
    WHERE gd.org_id = ${orgId}
      AND gd.dry_run = false
      AND gd.created_at >= ${day}::date
      AND gd.created_at <  ${day}::date + interval '1 day'
  `;

  rows.push(
    { metric: "gate_blocked", value: gate?.blocked ?? 0 },
    { metric: "gate_warned", value: gate?.warned ?? 0 },
    { metric: "gate_approved", value: gate?.approved ?? 0 },
  );

  const [reflex] = await sql<{ detected: number; reverted: number }[]>`
    SELECT count(*)::int AS detected,
           count(*) FILTER (WHERE reverted_at IS NOT NULL)::int AS reverted
    FROM reflex_incidents
    WHERE org_id = ${orgId}
      AND detected_at >= ${day}::date
      AND detected_at <  ${day}::date + interval '1 day'
  `;

  rows.push(
    { metric: "incidents_detected", value: reflex?.detected ?? 0 },
    { metric: "reverts_executed", value: reflex?.reverted ?? 0 },
  );

  const [drift] = await sql<{ opened: number; resolved: number }[]>`
    SELECT
      count(*) FILTER (WHERE created_at >= ${day}::date
                         AND created_at <  ${day}::date + interval '1 day')::int AS opened,
      count(*) FILTER (WHERE resolved_at >= ${day}::date
                         AND resolved_at <  ${day}::date + interval '1 day')::int AS resolved
    FROM drift_findings
    WHERE org_id = ${orgId}
  `;

  rows.push(
    { metric: "drift_opened", value: drift?.opened ?? 0 },
    { metric: "drift_resolved", value: drift?.resolved ?? 0 },
  );

  /**
   * Coverage is a *state on that day*, not an event count, so the honest value
   * is the one at the time it was computed. Backfilling it would report
   * today's coverage against last week's date — a rising line that says
   * nothing about last week.
   */
  const isToday = day === new Date().toISOString().slice(0, 10);
  if (isToday) {
    const [coverage] = await sql<{ confirmed: number; total: number }[]>`
      SELECT
        (SELECT count(DISTINCT rl.edge_id)
           FROM rationale_links rl
           JOIN rationale r ON r.id = rl.rationale_id
          WHERE r.org_id = ${orgId} AND r.state = 'confirmed')::int AS confirmed,
        (SELECT count(*) FROM edges WHERE org_id = ${orgId} AND state = 'active')::int AS total
    `;
    const total = coverage?.total ?? 0;
    rows.push({
      metric: "coverage_confirmed",
      value: total === 0 ? 0 : (coverage?.confirmed ?? 0) / total,
      meta: { confirmed: coverage?.confirmed ?? 0, totalEdges: total },
    });
  }

  for (const row of rows) {
    await sql`
      INSERT INTO metric_rollups (org_id, day, metric, value, meta, computed_at)
      VALUES (${orgId}, ${day}::date, ${row.metric}, ${row.value},
              ${row.meta ? JSON.stringify(row.meta) : null}::jsonb, now())
      ON CONFLICT (org_id, day, metric)
      DO UPDATE SET value = EXCLUDED.value,
                    meta = EXCLUDED.meta,
                    computed_at = now()
    `;
  }

  return rows.length;
}

/** Recomputes the trailing window for one org. Safe to run repeatedly. */
export async function rollupDaily(
  orgId: number,
  days = TRAILING_DAYS,
): Promise<RollupResult> {
  let written = 0;

  for (let back = 0; back < days; back += 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - back);
    written += await rollupDay(orgId, date.toISOString().slice(0, 10));
  }

  log().info({ event: "metrics_rolled_up", orgId, days, rows: written });
  return { days, rows: written };
}

/**
 * Backfill from a start date. Same code path as the nightly run — if it were a
 * separate implementation the two would disagree, and the disagreement would
 * show up as a step in the chart at the boundary between them.
 */
export async function backfill(orgId: number, from: Date): Promise<RollupResult> {
  /**
   * Counted in calendar days, matching how rollupDaily walks backwards.
   * Dividing elapsed milliseconds instead disagreed whenever `from` was later
   * in the day than now: backfilling from Jan 1st 18:00 at Jan 8th 09:00 gave
   * six-and-a-bit days, so Jan 1st was never computed. Rollups are upserted
   * rather than swept, so that gap was permanent and indistinguishable from a
   * day the product did not exist.
   */
  const startOfDay = (date: Date) =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(from)) / 86_400_000) + 1;
  return rollupDaily(orgId, Math.max(1, days));
}

export interface SeriesPoint {
  day: string;
  value: number;
  meta: Record<string, unknown> | null;
}

/** One metric over a window, oldest first, for a chart. */
export async function series(
  orgId: number,
  metric: string,
  fromDay: string,
  toDay: string,
): Promise<SeriesPoint[]> {
  const rows = await db
    .select({
      day: metricRollups.day,
      value: metricRollups.value,
      meta: metricRollups.meta,
    })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.orgId, orgId),
        eq(metricRollups.metric, metric),
        gte(metricRollups.day, fromDay),
        lte(metricRollups.day, toDay),
      ),
    )
    .orderBy(asc(metricRollups.day));

  return rows.map((row) => ({
    day: row.day,
    value: Number(row.value),
    meta: row.meta ?? null,
  }));
}
