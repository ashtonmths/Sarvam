"use client";

import Link from "next/link";
import { PageHead } from "../../../components/app/ui";
import type { Coverage, DecisionRow, GraphStats, Incident, Page } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * Observable facts lead; anything modelled is labelled as modelled.
 *
 * Nothing here claims prevention for Reflex, nothing sums coverage into one
 * number, and no counterfactual "saved" figure appears anywhere — those are
 * exactly the three overclaims that would undo the honesty work elsewhere.
 */
export default function MetricsPage() {
  const coverage = useQuery<Coverage>("/api/metrics/coverage");
  const stats = useQuery<GraphStats>("/api/graph/stats");
  const decisions = useQuery<Page<DecisionRow>>("/api/gate/decisions?limit=200");
  const incidents = useQuery<{ items: Incident[] }>("/api/incidents");

  const rows = decisions.data?.items ?? [];
  // Dry-runs are simulations; counting them as enforcement would inflate every
  // number on this page.
  const enforced = rows.filter((r) => !r.dryRun);
  const counts = {
    BLOCK: enforced.filter((r) => r.verdict === "BLOCK").length,
    WARN: enforced.filter((r) => r.verdict === "WARN").length,
    APPROVE: enforced.filter((r) => r.verdict === "APPROVE").length,
  };

  const allIncidents = incidents.data?.items ?? [];
  const reverted = allIncidents.filter((i) => i.state === "reverted");
  const acknowledged = allIncidents.filter((i) => i.state === "acknowledged");

  const cov = coverage.data;
  const pct =
    cov && cov.totalEdges > 0
      ? Math.round((cov.coverageConfirmed / cov.totalEdges) * 100)
      : 0;
  const pendingPct =
    cov && cov.totalEdges > 0
      ? Math.round((cov.coveragePending / cov.totalEdges) * 100)
      : 0;

  return (
    <>
      <PageHead
        title="Metrics"
        sub="Observable facts only. Nothing here is a counterfactual, and coverage is always two numbers rather than one."
      />

      <div className="panel-grid panel-grid--3" style={{ marginBottom: 16 }}>
        <section className="panel">
          <h2 className="panel__title">Changes gated</h2>
          <p className="panel__caption">
            Enforced modes only. Dry-run simulations are excluded from every number here.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="vbadge vbadge--block">{counts.BLOCK} blocked</span>
            <span className="vbadge vbadge--warn">{counts.WARN} warned</span>
            <span className="vbadge vbadge--approve">{counts.APPROVE} approved</span>
          </div>
          <p className="dim" style={{ fontSize: 12.5 }}>
            {rows.length - enforced.length} additional simulations recorded and excluded.
          </p>
        </section>

        <section className="panel">
          <h2 className="panel__title">Reflex</h2>
          <p className="panel__caption">
            Reflex detects and undoes after the fact. It does not prevent changes, and
            nothing on this page claims it does.
          </p>
          <div className="stat" style={{ marginBottom: 8 }}>
            <span className="stat__value">{reverted.length}</span>
            <span className="stat__hint">reverts executed</span>
          </div>
          <p className="dim" style={{ fontSize: 12.5 }}>
            {allIncidents.length} changes detected · {acknowledged.length} acknowledged by
            a human
          </p>
        </section>

        <section className="panel">
          <h2 className="panel__title">Coverage</h2>
          <p className="panel__caption">
            Confirmed rationale only. Drafts are shown separately and never counted.
          </p>
          <div className="stat" style={{ marginBottom: 10 }}>
            <span className="stat__value">{pct}%</span>
            <span className="stat__hint">
              {cov?.coverageConfirmed ?? 0} of {cov?.totalEdges ?? 0} edges confirmed
              {(cov?.coveragePending ?? 0) > 0 && ` · +${pendingPct}% pending review`}
            </span>
          </div>
          <div className="chart">
            <svg
              viewBox="0 0 300 60"
              role="img"
              aria-label="Confirmed versus pending coverage"
            >
              <text
                x={0}
                y={10}
                fontSize={9}
                fill="var(--ink-soft)"
                fontFamily="var(--font-mono)"
              >
                confirmed · counts toward coverage
              </text>
              <rect
                x={0}
                y={16}
                width={pct * 3}
                height={12}
                rx={4}
                fill="var(--approve)"
              />
              <text
                x={0}
                y={45}
                fontSize={9}
                fill="var(--ink-soft)"
                fontFamily="var(--font-mono)"
              >
                drafts pending · never counted
              </text>
              <rect
                x={0}
                y={50}
                width={pendingPct * 3}
                height={8}
                rx={4}
                fill="var(--warn)"
                opacity={0.7}
              />
            </svg>
          </div>
        </section>
      </div>

      <div className="panel-grid panel-grid--2">
        <section className="panel">
          <h2 className="panel__title">The graph</h2>
          <p className="panel__caption">What has been crawled, by kind and by state.</p>
          <table className="dtable">
            <tbody>
              <tr>
                <td>Nodes</td>
                <td className="mono">{stats.data?.nodes.total ?? 0}</td>
              </tr>
              <tr>
                <td>Dependencies</td>
                <td className="mono">{stats.data?.edges.total ?? 0}</td>
              </tr>
              <tr>
                <td>Stale (tombstoned, never deleted)</td>
                <td className="mono">{stats.data?.nodes.byState.stale ?? 0}</td>
              </tr>
              <tr>
                <td>Unresolved cross-connector refs</td>
                <td className="mono">{stats.data?.unresolvedRefs ?? 0}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2 className="panel__title">Edge provenance</h2>
          <p className="panel__caption">
            How each dependency was discovered. An{" "}
            <code className="mono">llm_inferred</code> edge can never on its own cause a
            BLOCK.
          </p>
          <table className="dtable">
            <tbody>
              {Object.entries(stats.data?.edges.byProvenance ?? {}).map(
                ([kind, count]) => (
                  <tr key={kind}>
                    <td className="mono">{kind}</td>
                    <td className="mono">{count}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>
            <Link href="/app/queue" style={{ color: "var(--thread)" }}>
              Review pending rationale →
            </Link>
          </p>
        </section>
      </div>
    </>
  );
}
