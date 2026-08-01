"use client";

import Link from "next/link";
import { EmptyState, PageHead, VerdictBadge } from "../../components/app/ui";
import type { DecisionRow, HistorianRun, Page, VerdictName } from "../../lib/api";
import { useGraphStats, useQuery } from "../../lib/queries";
import { useSession } from "../../lib/session";

interface WatchRow {
  node: { id: number; name: string; kind: string; criticality: number };
  downstream: number;
  maxImpact: number;
  verdict: VerdictName;
}

const OUTCOME_DOT: Record<string, string> = {
  done: "var(--approve)",
  running: "var(--thread)",
  queued: "var(--ink-faint)",
  cancelled: "var(--warn)",
};

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function OverviewPage() {
  const { org } = useSession();
  const { data: stats, loading } = useGraphStats(org?.id ?? null);
  const decisions = useQuery<Page<DecisionRow>>(
    org ? "/api/gate/decisions?limit=6" : null,
    [org?.id],
  );
  // Ranked by the gate's own arithmetic — a real traversal per candidate,
  // computed server-side rather than approximated here.
  const watchlist = useQuery<{ items: WatchRow[] }>(
    org ? "/api/graph/watchlist?limit=3" : null,
    [org?.id],
  );
  const runs = useQuery<{ items: HistorianRun[] }>(org ? "/api/historian/runs" : null, [
    org?.id,
  ]);

  if (loading) {
    return (
      <>
        <PageHead title="Overview" />
        <div className="panel" style={{ height: 120, opacity: 0.4 }} />
      </>
    );
  }

  const nodeCount = stats?.nodes.total ?? 0;

  if (nodeCount === 0) {
    return (
      <>
        <PageHead
          title={`Welcome to ${org?.name ?? "Sadhak"}`}
          sub="This org has no crawled systems yet, so there is no graph and nothing to gate."
        />
        <EmptyState
          title="Connect your first system"
          body="Sadhak crawls n8n, Airtable and Postgres read-only, assembles the dependency map, and gates the changes that would break it."
          action={{ href: "/app/settings/connectors", label: "Add a connector →" }}
        />
      </>
    );
  }

  const staleCount = stats?.nodes.byState.stale ?? 0;
  const connectors = Object.entries(stats?.nodes.byConnector ?? {});
  const kinds = Object.entries(stats?.nodes.byKind ?? {}).sort((a, b) => b[1] - a[1]);
  const maxKind = kinds[0]?.[1] ?? 1;
  // Oldest first, so the thread reads left to right toward "now".
  const tape = [...(decisions.data?.items ?? [])].reverse();
  const watch = watchlist.data?.items ?? [];
  const recentRuns = (runs.data?.items ?? []).slice(0, 3);

  return (
    <>
      <PageHead
        title="Overview"
        sub={`The gate's view of ${org?.name ?? "your org"}: what is mapped, what it decided, and what the agents are doing about the gaps.`}
      >
        <Link
          href="/app/graph"
          className="btn btn--ink btn--small"
          data-testid="overview-graph-cta"
        >
          Explore the graph
        </Link>
      </PageHead>

      {/* the last six verdicts, drawn as stations on the thread */}
      {tape.length > 0 && (
        <section
          className="tape"
          aria-label="Recent decisions"
          data-testid="overview-tape"
        >
          <div className="tape__track">
            <span className="tape__gate">
              <span className="tape__gate-dot" />
              the gate
            </span>
            {tape.map((d) => (
              <Link key={d.id} href="/app/decisions" className="tape__stop">
                <span className="tape__row">
                  <VerdictBadge verdict={d.verdict} />
                  {d.dryRun && <span className="tag tag--ghost">dry</span>}
                </span>
                <span className="tape__change">
                  {d.change.operation}{" "}
                  {String(d.change.externalId ?? "")
                    .split("/")
                    .pop()}
                </span>
                <span className="tape__when">
                  {timeAgo(d.createdAt)} · {d.mode}
                </span>
              </Link>
            ))}
            <span className="tape__now">now</span>
          </div>
        </section>
      )}

      <div className="ostats">
        <div className="ostats__cell">
          <strong>{nodeCount}</strong>
          <span>Nodes mapped</span>
          <em>
            across {connectors.length} connector{connectors.length === 1 ? "" : "s"}
          </em>
        </div>
        <div className="ostats__cell">
          <strong>{stats?.edges.total ?? 0}</strong>
          <span>Dependencies</span>
          <em>{stats?.edges.byProvenance.static_parse ?? 0} statically parsed</em>
        </div>
        <div className="ostats__cell">
          <strong>{staleCount}</strong>
          <span>Stale entities</span>
          <em>
            {staleCount === 0 ? "nothing has disappeared" : "tombstoned, never deleted"}
          </em>
        </div>
        <div className="ostats__cell">
          <strong>{stats?.unresolvedRefs ?? 0}</strong>
          <span>Unresolved refs</span>
          <em>we refused to guess at these</em>
        </div>
      </div>

      <div className="ogrid">
        <section className="panel">
          <h2 className="panel__title">Blast radius watchlist</h2>
          <p className="panel__caption">
            The most dangerous things to touch right now, ranked by the gate&rsquo;s own
            arithmetic over your real graph.
          </p>
          {watchlist.loading ? (
            <div style={{ height: 120, opacity: 0.4 }} />
          ) : watch.length === 0 ? (
            <p className="dim" style={{ fontSize: 13.5 }}>
              Nothing in this graph has dependents yet.
            </p>
          ) : (
            watch.map((w, i) => (
              <Link
                key={w.node.id}
                href={`/app/simulate?node=${w.node.id}`}
                className="watch"
                data-testid={`overview-watch-${i}`}
              >
                <span className="watch__rank">{String(i + 1).padStart(2, "0")}</span>
                <span className="watch__id">
                  <strong>{w.node.name}</strong>
                  <span>
                    {w.node.kind} · {w.downstream} downstream
                  </span>
                </span>
                <span className="watch__meter" aria-hidden="true">
                  <i
                    style={{
                      width: `${Math.round(w.maxImpact * 100)}%`,
                      background: w.verdict === "BLOCK" ? "var(--block)" : "var(--warn)",
                    }}
                  />
                </span>
                <span className="watch__impact">{w.maxImpact.toFixed(2)}</span>
                <VerdictBadge verdict={w.verdict} />
              </Link>
            ))
          )}
          <p className="panel__foot">
            impact = criticality × path confidence × 0.6^(hops−1) ·{" "}
            <Link href="/app/simulate">simulate a change →</Link>
          </p>
        </section>

        <div className="ogrid__stack">
          <section className="panel">
            <h2 className="panel__title">Agents at work</h2>
            <p className="panel__caption">
              What the historians did last, honest failures included.
            </p>
            {recentRuns.length === 0 ? (
              <p className="dim" style={{ fontSize: 13.5 }}>
                No investigations yet. Historian runs after a crawl, or when you start an
                exit interview.
              </p>
            ) : (
              recentRuns.map((run) => (
                <div className="arun" key={run.id}>
                  <span
                    className="arun__dot"
                    style={{ background: OUTCOME_DOT[run.state] ?? "var(--ink-faint)" }}
                    aria-hidden="true"
                  />
                  <span className="arun__body">
                    <strong>
                      {run.kind === "exit_interview"
                        ? "Exit interview"
                        : "Edge investigation"}
                    </strong>
                    <span>
                      {run.edgesProposed} drafted · {run.edgesGaveUp} honestly unexplained
                      {run.edgesSkippedQuota > 0 &&
                        ` · ${run.edgesSkippedQuota} quota-skipped`}
                    </span>
                  </span>
                  <span className="arun__when">
                    {run.requestsUsed} req · {timeAgo(run.createdAt)}
                  </span>
                </div>
              ))
            )}
            <p className="panel__foot">
              <Link href="/app/agents">All runs →</Link>
            </p>
          </section>

          <section className="panel">
            <h2 className="panel__title">What the map is made of</h2>
            <p className="panel__caption">Live counts from the last crawl.</p>
            {kinds.map(([kind, count]) => (
              <div className="kindbar" key={kind}>
                <span className="kindbar__label">{kind}</span>
                <span className="kindbar__track" aria-hidden="true">
                  <i style={{ width: `${Math.round((count / maxKind) * 100)}%` }} />
                </span>
                <span className="kindbar__count">{count}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </>
  );
}
