import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, sql } from "../db.js";
import { rollupDaily, series } from "./rollup.js";

/**
 * The property that matters is idempotence. These run nightly *and* as a
 * backfill over the same days, so a second pass that doubled a count would
 * turn every chart into a function of how often the job happened to run.
 */

let orgId: number;
const today = new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  await sql`TRUNCATE organizations CASCADE`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('R', 'r-org') RETURNING id
  `;
  orgId = Number(org?.id);
});

afterAll(async () => {
  await closePools();
});

async function decision(verdict: string, dryRun: boolean, key: string) {
  const [v] = await sql<{ id: string }[]>`
    INSERT INTO verdicts (org_id, change, verdict)
    VALUES (${orgId}, ${JSON.stringify({ t: "field" })}::jsonb, ${verdict})
    RETURNING id
  `;
  if (!v) throw new Error("fixture insert returned no verdict");

  await sql`
    INSERT INTO gate_decisions (org_id, mode, verdict_id, dry_run, idempotency_key)
    VALUES (${orgId}, 'proxy_gate', ${v.id}::uuid, ${dryRun}, ${key})
  `;
}

/** Named `metricOn` rather than `valueOf`, which shadows the global. */
async function metricOn(metric: string): Promise<number | undefined> {
  const points = await series(orgId, metric, today, today);
  return points[0]?.value;
}

describe("rollupDaily", () => {
  it("counts enforced decisions and excludes simulations", async () => {
    await decision("BLOCK", false, "k1");
    await decision("WARN", false, "k2");
    await decision("BLOCK", true, "k3");

    await rollupDaily(orgId, 1);

    expect(await metricOn("gate_blocked")).toBe(1);
    expect(await metricOn("gate_warned")).toBe(1);
  });

  it("produces the same numbers when run twice", async () => {
    // The whole reason this is an upsert over a trailing window rather than an
    // append. Nightly runs and backfills overlap by design.
    await decision("BLOCK", false, "k1");

    await rollupDaily(orgId, 1);
    const first = await metricOn("gate_blocked");
    await rollupDaily(orgId, 1);
    const second = await metricOn("gate_blocked");

    expect(second).toBe(first);
    expect(second).toBe(1);
  });

  it("writes one row per metric per day, not one per run", async () => {
    await decision("BLOCK", false, "k1");

    await rollupDaily(orgId, 1);
    await rollupDaily(orgId, 1);
    await rollupDaily(orgId, 1);

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM metric_rollups
      WHERE org_id = ${orgId} AND metric = 'gate_blocked'
    `;
    expect(row?.n).toBe(1);
  });

  it("picks up a late arrival on the next pass instead of freezing the day", async () => {
    await rollupDaily(orgId, 1);
    expect(await metricOn("gate_blocked")).toBe(0);

    // A webhook that arrived after the first run.
    await decision("BLOCK", false, "late");
    await rollupDaily(orgId, 1);

    expect(await metricOn("gate_blocked")).toBe(1);
  });

  it("records zero for a quiet day rather than leaving a hole", async () => {
    await rollupDaily(orgId, 1);

    // A missing point and a zero point look identical on a chart, and only one
    // of them means "nothing happened".
    expect(await metricOn("incidents_detected")).toBe(0);
    expect(await metricOn("drift_opened")).toBe(0);
  });

  it("covers the whole trailing window, so a gap cannot open", async () => {
    await rollupDaily(orgId, 7);

    const [row] = await sql<{ days: number }[]>`
      SELECT count(DISTINCT day)::int AS days FROM metric_rollups WHERE org_id = ${orgId}
    `;
    expect(row?.days).toBe(7);
  });
});

describe("coverage in the series", () => {
  it("is recorded for today only, because it is a state and not an event", async () => {
    // Backfilling coverage would report today's number against last week's
    // date — a rising line that says nothing about last week.
    await rollupDaily(orgId, 7);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const points = await series(orgId, "coverage_confirmed", yesterday, today);

    expect(points).toHaveLength(1);
    expect(points[0]?.day).toBe(today);
  });
});

describe("series", () => {
  it("returns points oldest first", async () => {
    await rollupDaily(orgId, 3);

    const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const points = await series(orgId, "gate_blocked", from, today);

    expect(points).toHaveLength(3);
    expect([...points].sort((a, b) => a.day.localeCompare(b.day))).toEqual(points);
  });

  it("is empty for a metric that has never been rolled up", async () => {
    expect(await series(orgId, "not_a_metric", today, today)).toEqual([]);
  });
});
