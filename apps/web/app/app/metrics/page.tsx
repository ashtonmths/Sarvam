"use client";

import Link from "next/link";
import { PageHead } from "../../../components/app/ui";
import type { GraphStats, MetricsSummary, Percentiles } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * Observable facts lead; anything modelled is labelled as modelled.
 *
 * The numbers come from `/api/metrics/summary`, computed server-side over the
 * event tables. This page used to fetch 200 decisions and aggregate them in the
 * browser, which was wrong past 200 rows and could not express the exclusions —
 * dry runs, drafted rationale, clock skew — that make these numbers defensible.
 *
 * Detect-to-repair leads, because it is the product's actual claim: the window
 * between a mistake and its repair goes from "we found out Saturday" to
 * seconds. Nothing else here is worth putting first.
 */

/** ms → the largest unit that stays readable. 11200 reads better as 11.2s. */
function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = ms / 60_000;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * A measured latency, or an honest absence. Never zero: a dashboard showing
 * "0ms" for something never measured reads as instant, which is the most
 * flattering possible lie.
 */
function Latency({
  label,
  value,
  hint,
}: {
  label: string;
  value: Percentiles | null;
  hint: string;
}) {
  return (
    <div className="lat">
      <span className="lat__label">{label}</span>
      {value === null ? (
        <>
          <span className="lat__value lat__value--empty">not yet measured</span>
          <span className="lat__hint">{hint}</span>
        </>
      ) : (
        <>
          <span className="lat__value">{humanMs(value.median)}</span>
          <span className="lat__hint">
            median · p95 {humanMs(value.p95)} ·{" "}
            <strong>
              {value.samples} sample{value.samples === 1 ? "" : "s"}
            </strong>
          </span>
        </>
      )}
    </div>
  );
}

export default function MetricsPage() {
  const metrics = useQuery<MetricsSummary>("/api/metrics/summary");
  const stats = useQuery<GraphStats>("/api/graph/stats");

  const m = metrics.data;
  const confirmedPct = Math.round((m?.coverageConfirmed ?? 0) * 100);
  const pendingPct = Math.round((m?.coveragePending ?? 0) * 100);

  if (metrics.loading) {
    return (
      <>
        <PageHead title="Metrics" />
        <div className="panel" style={{ height: 200, opacity: 0.4 }} />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Metrics"
        sub="Observable facts only. Every number is an event count or a timestamp delta from a table that exists for another reason — nothing is self-reported by a model, and nothing improves when the product degrades."
      />

      {/* The product's claim, measured. */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Mistake to repair</h2>
        <p className="panel__caption">
          How long a change went unnoticed, and how long undoing it took. Push and poll
          are never blended: a webhook and a 30-second poll are different mechanisms, and
          one average would describe neither.
        </p>

        <div className="lat-grid">
          <Latency
            label="Detected · push"
            value={m?.mttdMs.push ?? null}
            hint="webhook path, no incidents yet"
          />
          <Latency
            label="Detected · poll"
            value={m?.mttdMs.poll ?? null}
            hint="interval path, no incidents yet"
          />
          <Latency
            label="Alert to reverted"
            value={m?.mttrMs ?? null}
            hint="includes the human deciding"
          />
        </div>

        <p className="panel__foot">
          Detection is measured against the vendor&rsquo;s clock, so it is approximate by
          construction.
          {(m?.mttdSkewExcluded ?? 0) > 0 ? (
            <>
              {" "}
              <strong>{m?.mttdSkewExcluded}</strong> row
              {m?.mttdSkewExcluded === 1 ? " was" : "s were"} excluded for clock skew
              rather than clamped to zero.
            </>
          ) : (
            " Rows where their clock runs ahead of ours are excluded, never clamped."
          )}
        </p>
      </section>

      <div className="ostats">
        <div className="ostats__cell">
          <strong>{m?.revertsExecuted ?? 0}</strong>
          <span>Reverts executed</span>
          <em>ran and confirmed, not merely offered</em>
        </div>
        <div className="ostats__cell">
          <strong>{m?.highImpactReviewed ?? 0}</strong>
          <span>Impact surfaced</span>
          <em>WARN or BLOCK, simulations excluded</em>
        </div>
        <div className="ostats__cell">
          <strong>{m?.correctionsCaptured ?? 0}</strong>
          <span>Corrections captured</span>
          <em>human judgments a rival cannot crawl</em>
        </div>
        <div className="ostats__cell">
          <strong>{m?.totalEdges ?? 0}</strong>
          <span>Dependencies mapped</span>
          <em>active edges across every connector</em>
        </div>
      </div>

      <div className="panel-grid panel-grid--2">
        <section className="panel">
          <h2 className="panel__title">Coverage</h2>
          <p className="panel__caption">
            Two numbers, never one. A draft is a proposal until a person confirms it
            against its source, so it sits beside coverage and is never added to it.
          </p>

          <div className="stat" style={{ marginBottom: 10 }}>
            <span className="stat__value">{confirmedPct}%</span>
            <span className="stat__hint">
              of {m?.totalEdges ?? 0} edges have confirmed rationale
            </span>
          </div>

          <div className="chart">
            <svg
              viewBox="0 0 300 60"
              role="img"
              aria-label={`${confirmedPct} percent confirmed, ${pendingPct} percent drafted and not counted`}
            >
              <title>Confirmed versus drafted coverage</title>
              <text
                x={0}
                y={10}
                fontSize={9}
                fill="var(--ink-soft)"
                fontFamily="var(--font-mono)"
              >
                confirmed · counts toward coverage
              </text>
              <rect x={0} y={16} width={300} height={12} rx={4} fill="var(--line-soft)" />
              <rect
                x={0}
                y={16}
                width={confirmedPct * 3}
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
                drafted · never counted
              </text>
              <rect x={0} y={50} width={300} height={8} rx={4} fill="var(--line-soft)" />
              <rect
                x={0}
                y={50}
                width={pendingPct * 3}
                height={8}
                rx={4}
                fill="var(--warn)"
                opacity={0.75}
              />
            </svg>
          </div>

          <p className="panel__foot">
            <Link href="/app/queue">Review pending rationale →</Link>
          </p>
        </section>

        <section className="panel">
          <h2 className="panel__title">Edge provenance</h2>
          <p className="panel__caption">
            How each dependency was discovered. An{" "}
            <code className="mono">llm_inferred</code> edge can never on its own cause a
            BLOCK — it is capped at WARN in the scoring kernel.
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
      </div>

      {/*
        The only modelled figure, and it is absent until a backtest can ground
        it. Saying so is more useful than an estimate nobody can defend.
      */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel__title">What we do not claim</h2>
        <p className="panel__caption">
          Incidents avoided is an unprovable counterfactual: you cannot count the outages
          that did not happen.
          {m?.incidentsAvoidedModelled
            ? " The figure below is modelled from a backtest hit rate, and is labelled as modelled wherever it appears."
            : " No estimate appears here, because there is no backtest yet to ground one."}
        </p>
        {m?.incidentsAvoidedModelled && (
          <div className="stat">
            <span className="stat__value">{m.incidentsAvoidedModelled.value}</span>
            <span className="stat__hint">modelled, not observed</span>
          </div>
        )}
      </section>
    </>
  );
}
