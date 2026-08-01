"use client";

import Link from "next/link";
import { EmptyState, PageHead, VerdictBadge } from "../../components/app/ui";
import { AGENT_RUNS, DECISIONS, timeAgo } from "../../lib/mock/data";
import { SIMULATABLE_NODES, traverse, verdict } from "../../lib/mock/verdict";
import { useGraphStats } from "../../lib/queries";
import { useSession } from "../../lib/session";

// The three most dangerous things to touch right now, ranked by the same
// arithmetic the gate uses. Mock graph until the engine lands (plans 7-8).
const WATCHLIST = SIMULATABLE_NODES.map((n) => {
  const rows = traverse(n.id);
  const maxImpact = rows.reduce((m, r) => Math.max(m, r.impact), 0);
  return { node: n, downstream: rows.length, maxImpact, verdict: verdict(rows).verdict };
})
  .filter((w) => w.downstream > 0)
  .sort((a, b) => b.maxImpact - a.maxImpact)
  .slice(0, 3);

const TAPE = [...DECISIONS.slice(0, 6)].reverse();
const RUNS = AGENT_RUNS.slice(0, 3);

const OUTCOME_DOT: Record<string, string> = {
  propose_rationale: "var(--approve)",
  draft_correction: "var(--thread)",
  give_up: "var(--warn)",
  dismiss: "var(--ink-faint)",
};

export default function OverviewPage() {
  const { org } = useSession();
  const { data: stats, loading } = useGraphStats(org?.id ?? null);

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
      <section className="tape" aria-label="Recent decisions" data-testid="overview-tape">
        <div className="tape__track">
          <span className="tape__gate">
            <span className="tape__gate-dot" />
            the gate
          </span>
          {TAPE.map((d) => (
            <Link key={d.id} href="/app/decisions" className="tape__stop">
              <span className="tape__row">
                <VerdictBadge verdict={d.verdict} />
                {d.dryRun && <span className="tag tag--ghost">dry</span>}
              </span>
              <span className="tape__change">{d.change}</span>
              <span className="tape__when">
                {timeAgo(d.at)} · {d.mode}
              </span>
            </Link>
          ))}
          <span className="tape__now">now</span>
        </div>
      </section>

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
            The most dangerous things to touch right now, ranked by the gate's own
            arithmetic. Sample graph until plans 7 and 8 land.
          </p>
          {WATCHLIST.map((w, i) => (
            <Link
              key={w.node.id}
              href="/app/simulate"
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
          ))}
          <p className="panel__foot">
            impact = criticality × path confidence × 0.6^(hops−1) ·{" "}
            <Link href="/app/simulate">simulate a change →</Link>
          </p>
        </section>

        <div className="ogrid__stack">
          <section className="panel">
            <h2 className="panel__title">Agents at work</h2>
            <p className="panel__caption">
              What the historians and reviewers did last, honest failures included.
            </p>
            {RUNS.map((run) => (
              <div className="arun" key={run.id}>
                <span
                  className="arun__dot"
                  style={{ background: OUTCOME_DOT[run.outcome] ?? "var(--ink-faint)" }}
                  aria-hidden="true"
                />
                <span className="arun__body">
                  <strong>{run.goal}</strong>
                  <span>{run.outcomeDetail}</span>
                </span>
                <span className="arun__when">
                  {Math.round(run.durationMs / 1000)}s · {timeAgo(run.startedAt)}
                </span>
              </div>
            ))}
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
