"use client";

import Link from "next/link";
import { PageHead } from "../../../components/app/ui";
import type {
  GraphStats,
  MetricsSummary,
  Percentiles,
  SeriesPoint,
  SeriesResponse,
} from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * Observable facts only. Every number here is an event count or a timestamp
 * delta from a table that exists for another reason — nothing is self-reported
 * by a model, and nothing improves when the product degrades.
 *
 * The page is laid out around a fact about this data rather than around the
 * list of things measured: most of it is legitimately empty. No incidents yet
 * means no detection latency; nothing confirmed yet means no coverage. The old
 * layout opened with three "not yet measured" boxes, so the first thing anyone
 * saw was an absence, and it read as broken rather than early.
 *
 * So the order is now: what the system is watching (always true), what it has
 * done (sparse but real), then what it cannot yet measure — stated as a
 * milestone with the action that reaches it, not as a blank. An empty metric is
 * a stage of the deployment, and saying so is more useful than a dash.
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
 * A number with its unit set apart, so `17` and `edges` do not compete.
 *
 * The value carries the display face at a size worth reading across a room; the
 * label is monospaced and small. That contrast is the entire reason the figure
 * registers before the caption does.
 */
function Figure({
  value,
  label,
  note,
  tone = "ink",
}: {
  value: string | number;
  label: string;
  note?: string;
  tone?: "ink" | "approve" | "warn" | "block" | "thread";
}) {
  return (
    <div className="mx-fig" data-tone={tone}>
      <span className="mx-fig__value">{value}</span>
      <span className="mx-fig__label">{label}</span>
      {note && <span className="mx-fig__note">{note}</span>}
    </div>
  );
}

/**
 * A measured latency, or the milestone that would produce one.
 *
 * Never zero, and never a dash. A dashboard showing "0ms" for something never
 * measured reads as instant, which is the most flattering possible lie; a dash
 * reads as broken. Naming what has to happen first is the only honest option
 * that is also useful.
 */
function Latency({
  label,
  value,
  awaiting,
}: {
  label: string;
  value: Percentiles | null;
  awaiting: string;
}) {
  if (value === null) {
    return (
      <div className="mx-lat mx-lat--waiting">
        <span className="mx-lat__label">{label}</span>
        <span className="mx-lat__await">{awaiting}</span>
      </div>
    );
  }
  return (
    <div className="mx-lat">
      <span className="mx-lat__label">{label}</span>
      <span className="mx-lat__value">{humanMs(value.median)}</span>
      <span className="mx-lat__hint">
        median · p95 {humanMs(value.p95)} · {value.samples} sample
        {value.samples === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/**
 * The gate's daily verdicts as one row of stacked columns.
 *
 * Written here rather than reusing StackedSeries because this data is mostly
 * zeros, and a chart library's answer to that is a flat line against an axis —
 * which looks like a failure to load. Days with nothing get a visible baseline
 * tick instead: the grid stays legible, and a single blocked change on one day
 * is unmissable rather than a pixel.
 */
function GateStrip({
  blocked,
  warned,
  approved,
}: {
  blocked: SeriesPoint[];
  warned: SeriesPoint[];
  approved: SeriesPoint[];
}) {
  const days = blocked.map((point, i) => ({
    day: point.day,
    blocked: point.value,
    warned: warned[i]?.value ?? 0,
    approved: approved[i]?.value ?? 0,
  }));

  const peak = Math.max(1, ...days.map((d) => d.blocked + d.warned + d.approved));
  const total = days.reduce((sum, d) => sum + d.blocked + d.warned + d.approved, 0);

  if (days.length === 0) {
    return (
      <p className="mx-empty">
        No decisions recorded yet. Columns appear once the gate has been asked something
        and the nightly rollup has run.
      </p>
    );
  }

  return (
    <>
      <div
        className="mx-strip"
        role="img"
        aria-label={`${total} enforced decisions over ${days.length} days`}
      >
        {days.map((d) => {
          const sum = d.blocked + d.warned + d.approved;
          return (
            <div
              className="mx-strip__day"
              key={d.day}
              title={`${d.day}: ${sum} decision${sum === 1 ? "" : "s"}`}
            >
              <div className="mx-strip__stack">
                {sum === 0 ? (
                  <span className="mx-strip__none" />
                ) : (
                  <>
                    {d.approved > 0 && (
                      <span
                        className="mx-strip__bar mx-strip__bar--approve"
                        style={{ height: `${(d.approved / peak) * 100}%` }}
                      />
                    )}
                    {d.warned > 0 && (
                      <span
                        className="mx-strip__bar mx-strip__bar--warn"
                        style={{ height: `${(d.warned / peak) * 100}%` }}
                      />
                    )}
                    {d.blocked > 0 && (
                      <span
                        className="mx-strip__bar mx-strip__bar--block"
                        style={{ height: `${(d.blocked / peak) * 100}%` }}
                      />
                    )}
                  </>
                )}
              </div>
              <span className="mx-strip__tick">{d.day.slice(8)}</span>
            </div>
          );
        })}
      </div>
      <div className="mx-legend">
        <span className="mx-legend__item mx-legend__item--block">blocked</span>
        <span className="mx-legend__item mx-legend__item--warn">warned</span>
        <span className="mx-legend__item mx-legend__item--approve">approved</span>
        <span className="mx-legend__spacer" />
        <span className="mx-legend__note">enforced only · dry runs excluded</span>
      </div>
    </>
  );
}

export default function MetricsPage() {
  const metrics = useQuery<MetricsSummary>("/api/metrics/summary");
  const stats = useQuery<GraphStats>("/api/graph/stats");
  const blocked = useQuery<SeriesResponse>("/api/metrics/series/gate_blocked");
  const warned = useQuery<SeriesResponse>("/api/metrics/series/gate_warned");
  const approved = useQuery<SeriesResponse>("/api/metrics/series/gate_approved");

  const m = metrics.data;
  const s = stats.data;
  const confirmedPct = Math.round((m?.coverageConfirmed ?? 0) * 100);
  const pendingPct = Math.round((m?.coveragePending ?? 0) * 100);
  const totalEdges = m?.totalEdges ?? 0;
  const drafted = Math.round((m?.coveragePending ?? 0) * totalEdges);

  if (metrics.loading) {
    return (
      <>
        <PageHead title="Metrics" />
        <div className="mx-skeleton" aria-hidden />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Metrics"
        sub="Every number below is an event count or a timestamp delta from a table that exists for another reason. Nothing is self-reported by a model, and nothing improves when the product degrades."
      />

      {/*
        What is under watch. This is the one band that is always true — a graph
        exists from the first crawl — so it opens the page and gives the layout
        something with weight at the top.
      */}
      <section className="mx-hero">
        <Figure value={s?.nodes.total ?? 0} label="nodes mapped" tone="thread" />
        <Figure value={totalEdges} label="dependencies tracked" tone="thread" />
        <Figure
          value={m?.highImpactReviewed ?? 0}
          label="changes with impact surfaced"
          note="WARN or BLOCK, simulations excluded"
          tone={(m?.highImpactReviewed ?? 0) > 0 ? "warn" : "ink"}
        />
        <Figure
          value={m?.knowledgeConcentration.atRiskNodes ?? 0}
          label="single points of knowledge"
          note={
            (m?.knowledgeConcentration.unknownNodes ?? 0) > 0
              ? `${m?.knowledgeConcentration.unknownNodes} unmined, not counted`
              : "one author in the evidence"
          }
          tone={(m?.knowledgeConcentration.atRiskNodes ?? 0) > 0 ? "block" : "ink"}
        />
      </section>

      <section className="panel mx-panel">
        <header className="mx-panel__head">
          <div>
            <h2 className="panel__title">What the gate decided</h2>
            <p className="panel__caption">
              Enforced decisions by day. A dry run is a question rather than an
              enforcement, and counting simulations here would inflate every column.
            </p>
          </div>
        </header>
        <GateStrip
          blocked={blocked.data?.points ?? []}
          warned={warned.data?.points ?? []}
          approved={approved.data?.points ?? []}
        />
      </section>

      <div className="mx-split">
        <section className="panel mx-panel">
          <h2 className="panel__title">Coverage</h2>
          <p className="panel__caption">
            Two numbers, never one. A draft is a proposal until a person confirms it
            against its source, so it sits beside coverage and is never added to it.
          </p>

          <div className="mx-cov">
            <div className="mx-cov__figure">
              <span className="mx-cov__pct">{confirmedPct}%</span>
              <span className="mx-cov__of">of {totalEdges} dependencies explained</span>
            </div>

            <div className="mx-cov__bars">
              <div className="mx-cov__row">
                <span className="mx-cov__key">confirmed</span>
                <span className="mx-cov__track">
                  <span
                    className="mx-cov__fill mx-cov__fill--approve"
                    style={{
                      width: `${Math.max(confirmedPct, confirmedPct > 0 ? 2 : 0)}%`,
                    }}
                  />
                </span>
                <span className="mx-cov__num">{confirmedPct}%</span>
              </div>
              <div className="mx-cov__row">
                <span className="mx-cov__key">drafted</span>
                <span className="mx-cov__track">
                  <span
                    className="mx-cov__fill mx-cov__fill--warn"
                    style={{ width: `${Math.max(pendingPct, pendingPct > 0 ? 2 : 0)}%` }}
                  />
                </span>
                <span className="mx-cov__num">{pendingPct}%</span>
              </div>
            </div>
          </div>

          {drafted > 0 ? (
            <p className="mx-cta">
              <Link href="/app/queue">
                {drafted} draft{drafted === 1 ? "" : "s"} waiting on a human →
              </Link>
            </p>
          ) : (
            <p className="panel__foot">
              Nothing is waiting for review. The Historian proposes rationale; drafts
              appear here for confirmation.
            </p>
          )}
        </section>

        <section className="panel mx-panel">
          <h2 className="panel__title">Where dependencies came from</h2>
          <p className="panel__caption">
            An <code className="mono">llm_inferred</code> edge can never on its own cause
            a BLOCK — the scoring kernel caps it at WARN.
          </p>

          <ul className="mx-prov">
            {Object.entries(s?.edges.byProvenance ?? {}).map(([kind, count]) => (
              <li className="mx-prov__row" key={kind}>
                <span className="mx-prov__kind">{kind.replace(/_/g, " ")}</span>
                <span className="mx-prov__bar">
                  <span
                    className="mx-prov__fill"
                    style={{
                      width: `${((count as number) / Math.max(1, totalEdges)) * 100}%`,
                    }}
                  />
                </span>
                <span className="mx-prov__count">{count as number}</span>
              </li>
            ))}
          </ul>

          <div className="mx-notes">
            <span>
              <strong>{s?.nodes.byState.stale ?? 0}</strong> stale, tombstoned rather than
              deleted
            </span>
            <span>
              <strong>{s?.unresolvedRefs ?? 0}</strong> unresolved cross-connector refs
            </span>
          </div>
        </section>
      </div>

      {/*
        Latency last, because it is the part that is empty until an incident
        happens — and an incident is not something to wish for to fill a chart.
      */}
      <section className="panel mx-panel">
        <header className="mx-panel__head">
          <div>
            <h2 className="panel__title">Mistake to repair</h2>
            <p className="panel__caption">
              How long a change went unnoticed, and how long undoing it took. Push and
              poll are never blended: a webhook and a 30-second interval are different
              mechanisms, and one average would describe neither.
            </p>
          </div>
        </header>

        <div className="mx-lat-grid">
          <Latency
            label="Detected · push"
            value={m?.mttdMs.push ?? null}
            awaiting="measured on the first webhook-detected change"
          />
          <Latency
            label="Detected · poll"
            value={m?.mttdMs.poll ?? null}
            awaiting="measured on the first polled change"
          />
          <Latency
            label="Alert to reverted"
            value={m?.mttrMs ?? null}
            awaiting="measured on the first executed revert"
          />
        </div>

        <p className="panel__foot">
          Detection is measured against the vendor&rsquo;s clock, so it is approximate by
          construction.{" "}
          {(m?.mttdSkewExcluded ?? 0) > 0 ? (
            <>
              <strong>{m?.mttdSkewExcluded}</strong> row
              {m?.mttdSkewExcluded === 1 ? " was" : "s were"} excluded for clock skew
              rather than clamped to zero.
            </>
          ) : (
            "Rows where their clock runs ahead of ours are excluded, never clamped."
          )}
        </p>
      </section>

      <section className="mx-disclaim">
        <h2 className="mx-disclaim__title">What we do not claim</h2>
        <p>
          Incidents avoided is an unprovable counterfactual — you cannot count the outages
          that did not happen.{" "}
          {m?.incidentsAvoidedModelled
            ? "The figure below is modelled from a backtest hit rate, and is labelled as modelled wherever it appears."
            : "No estimate appears here, because there is no backtest yet to ground one."}
        </p>
        {m?.incidentsAvoidedModelled && (
          <p className="mx-disclaim__value">
            <strong>{m.incidentsAvoidedModelled.value}</strong> modelled, not observed
          </p>
        )}
      </section>
    </>
  );
}
