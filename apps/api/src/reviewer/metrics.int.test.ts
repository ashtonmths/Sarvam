import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, sql } from "../db.js";
import { computeMetrics } from "./metrics.js";

/**
 * These numbers go on a page a customer reads and a judge scrutinises, so the
 * tests are written against the ways a number could be made to look better
 * than the truth: counting simulations as enforcement, counting a model's
 * drafts as knowledge, blending two detection paths, or clamping clock skew to
 * zero instead of excluding it.
 */

let orgId: number;
let instanceId: number;

beforeEach(async () => {
  await sql`TRUNCATE organizations CASCADE`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('M', 'm-org') RETURNING id
  `;
  orgId = Number(org?.id);
  const [inst] = await sql<{ id: string }[]>`
    INSERT INTO connector_instances (org_id, connector, display_name, config)
    VALUES (${orgId}, 'airtable', 'a', '{}'::jsonb) RETURNING id
  `;
  instanceId = Number(inst?.id);
});

afterAll(async () => {
  await closePools();
});

/** Detected `detectedAfterMs` after the change the vendor reported. */
async function incident(opts: {
  key: string;
  detectPath: "push" | "poll";
  detectedAfterMs: number;
  revertedAfterAlertMs?: number;
}) {
  const changeAt = new Date("2026-07-01T10:00:00Z");
  const detectedAt = new Date(changeAt.getTime() + opts.detectedAfterMs);
  const alertedAt = new Date(detectedAt.getTime() + 500);
  const revertedAt =
    opts.revertedAfterAlertMs === undefined
      ? null
      : new Date(alertedAt.getTime() + opts.revertedAfterAlertMs);

  await sql`
    INSERT INTO reflex_incidents
      (org_id, dedupe_key, connector, target, operation, external_id,
       detect_path, change_at, detected_at, alerted_at, reverted_at, state)
    VALUES (${orgId}, ${opts.key}, 'airtable', 'field', 'delete', 'fld1',
            ${opts.detectPath}, ${changeAt.toISOString()}::timestamptz,
            ${detectedAt.toISOString()}::timestamptz,
            ${alertedAt.toISOString()}::timestamptz,
            ${revertedAt ? revertedAt.toISOString() : null}::timestamptz,
            ${revertedAt ? "reverted" : "alerted"})
  `;
}

/** Inserts a row and returns its id, failing loudly rather than yielding undefined. */
async function insertReturningId(query: Promise<{ id: string }[]>): Promise<string> {
  const [row] = await query;
  if (!row) throw new Error("fixture insert returned no row");
  return row.id;
}

/** The verdict text lives on `verdicts`; the decision points at it. */
async function decision(verdict: string, dryRun: boolean, key: string) {
  const verdictId = await insertReturningId(sql<{ id: string }[]>`
    INSERT INTO verdicts (org_id, change, verdict)
    VALUES (${orgId}, ${JSON.stringify({ target: "field" })}::jsonb, ${verdict})
    RETURNING id
  `);
  await sql`
    INSERT INTO gate_decisions (org_id, mode, verdict_id, dry_run, idempotency_key)
    VALUES (${orgId}, 'proxy_gate', ${verdictId}::uuid, ${dryRun}, ${key})
  `;
}

describe("detection latency", () => {
  it("keeps push and poll apart, because one average describes neither", async () => {
    await incident({ key: "a", detectPath: "push", detectedAfterMs: 2000 });
    await incident({ key: "b", detectPath: "push", detectedAfterMs: 3000 });
    await incident({ key: "c", detectPath: "poll", detectedAfterMs: 30_000 });

    const m = await computeMetrics(orgId);

    expect(m.mttdMs.push?.median).toBe(3000);
    expect(m.mttdMs.poll?.median).toBe(30_000);
    // A blended median would be 3000 and would describe neither mechanism.
    expect(m.mttdMs.push?.samples).toBe(2);
    expect(m.mttdMs.poll?.samples).toBe(1);
  });

  it("excludes clock skew rather than clamping it to zero", async () => {
    // change_at is the vendor's clock. A change that appears to happen after
    // we detected it is skew; clamping it to 0 would quietly improve the
    // median, so it is dropped and counted.
    await incident({ key: "a", detectPath: "push", detectedAfterMs: 2000 });
    await incident({ key: "skewed", detectPath: "push", detectedAfterMs: -5000 });

    const m = await computeMetrics(orgId);

    expect(m.mttdSkewExcluded).toBe(1);
    expect(m.mttdMs.push?.samples).toBe(1);
    expect(m.mttdMs.push?.median).toBe(2000);
  });

  it("reports null rather than zero when there is nothing to measure", async () => {
    const m = await computeMetrics(orgId);

    // Zero would read as "instant detection" on a dashboard.
    expect(m.mttdMs.push).toBeNull();
    expect(m.mttdMs.poll).toBeNull();
    expect(m.mttrMs).toBeNull();
  });

  it("carries the sample count, so a p95 over two rows is visible as such", async () => {
    await incident({ key: "a", detectPath: "push", detectedAfterMs: 1000 });

    const m = await computeMetrics(orgId);

    expect(m.mttdMs.push?.samples).toBe(1);
  });
});

describe("reverts", () => {
  it("counts reverts that ran, not reverts that were offered", async () => {
    await incident({ key: "a", detectPath: "push", detectedAfterMs: 1000 });
    await incident({
      key: "b",
      detectPath: "push",
      detectedAfterMs: 1000,
      revertedAfterAlertMs: 9000,
    });

    const m = await computeMetrics(orgId);

    expect(m.revertsExecuted).toBe(1);
    expect(m.mttrMs?.median).toBe(9000);
  });
});

describe("gate decisions", () => {
  it("never counts a dry run as enforcement", async () => {
    await decision("BLOCK", false, "k1");
    await decision("WARN", false, "k2");
    await decision("BLOCK", true, "k3");
    await decision("APPROVE", false, "k4");

    const m = await computeMetrics(orgId);

    // Two: the non-dry-run WARN and BLOCK. The simulated BLOCK is a question,
    // and the APPROVE surfaced nothing to anyone.
    expect(m.highImpactReviewed).toBe(2);
  });
});

describe("coverage", () => {
  async function edgeWithRationale(state: "confirmed" | "drafted", n: number) {
    const src = await insertReturningId(sql<{ id: string }[]>`
      INSERT INTO nodes (org_id, kind, name, external_id, connector, criticality)
      VALUES (${orgId}, 'table', ${`t${n}`}, ${`x/t${n}`}, 'airtable', 1) RETURNING id
    `);
    const dst = await insertReturningId(sql<{ id: string }[]>`
      INSERT INTO nodes (org_id, kind, name, external_id, connector, criticality)
      VALUES (${orgId}, 'field', ${`f${n}`}, ${`x/f${n}`}, 'airtable', 1) RETURNING id
    `);
    const edge = await insertReturningId(sql<{ id: string }[]>`
      INSERT INTO edges (org_id, src_id, dst_id, kind, confidence, provenance)
      VALUES (${orgId}, ${src}, ${dst}, 'READS_FROM', 1, 'static_parse')
      RETURNING id
    `);
    const rationaleId = await insertReturningId(sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, state)
      VALUES (${orgId}, 'because', 'slack', 'https://example.com/1', ${state})
      RETURNING id
    `);
    await sql`
      INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${rationaleId}, ${edge})
    `;
  }

  it("counts confirmed and pending separately and never sums them", async () => {
    await edgeWithRationale("confirmed", 1);
    await edgeWithRationale("drafted", 2);

    const m = await computeMetrics(orgId);

    expect(m.totalEdges).toBe(2);
    expect(m.coverageConfirmed).toBe(0.5);
    expect(m.coveragePending).toBe(0.5);
    // A model's draft is a proposal. Reporting 100% here would be the single
    // most misleading number this product could show.
    expect(m.coverageConfirmed).not.toBe(1);
  });

  it("reports zero coverage rather than dividing by zero on an empty graph", async () => {
    const m = await computeMetrics(orgId);

    expect(m.coverageConfirmed).toBe(0);
    expect(m.totalEdges).toBe(0);
  });
});

describe("corrections captured", () => {
  async function finding(state: string, dismissedBy: string | null) {
    await sql`
      INSERT INTO drift_findings
        (org_id, connector_instance_id, kind, scope, signature, state,
         dismiss_reason, dismissed_by, resolved_at)
      VALUES (${orgId}, ${instanceId}, 'hash_change', 'a', ${`sig-${Math.random()}`},
              ${state}::finding_state, 'why', ${dismissedBy}, now())
    `;
  }

  it("counts human judgments and not the agent's queue clearing", async () => {
    await finding("corrected", null);
    await finding("dismissed", "operator@example.com");
    await finding("dismissed", "reviewer");

    const m = await computeMetrics(orgId);

    // The agent dismissal cleared a queue entry; it is not company knowledge,
    // and counting it would inflate the one number meant to show a moat.
    expect(m.correctionsCaptured).toBe(2);
  });
});

describe("the modelled number", () => {
  it("is null until a backtest can ground it", async () => {
    const m = await computeMetrics(orgId);

    // An unbacked estimate is worse than an absent one, and the type only
    // permits a value alongside `modelled: true`.
    expect(m.incidentsAvoidedModelled).toBeNull();
  });
});
