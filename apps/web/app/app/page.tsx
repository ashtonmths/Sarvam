"use client";

import Link from "next/link";
import { EmptyState, PageHead, Stat, VerdictBadge } from "../../components/app/ui";
import { DECISIONS, timeAgo } from "../../lib/mock/data";
import { useGraphStats } from "../../lib/queries";
import { useSession } from "../../lib/session";

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
  const recent = DECISIONS.slice(0, 5);

  return (
    <>
      <PageHead
        title="Overview"
        sub="What has been crawled, what the gate has decided, and how much of the map is explained."
      >
        <Link
          href="/app/graph"
          className="btn btn--ink btn--small"
          data-testid="overview-graph-cta"
        >
          Explore the graph
        </Link>
      </PageHead>

      <div className="panel-grid panel-grid--4" style={{ marginBottom: 16 }}>
        <Stat
          label="Nodes mapped"
          value={nodeCount}
          hint={`across ${connectors.length} connector${connectors.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Dependencies"
          value={stats?.edges.total ?? 0}
          hint={`${stats?.edges.byProvenance.static_parse ?? 0} statically parsed`}
        />
        <Stat
          label="Stale entities"
          value={staleCount}
          hint={
            staleCount === 0 ? "nothing has disappeared" : "tombstoned, never deleted"
          }
        />
        <Stat
          label="Unresolved refs"
          value={stats?.unresolvedRefs ?? 0}
          hint="cross-connector references we refused to guess at"
        />
      </div>

      <div className="panel-grid panel-grid--2">
        <section className="panel">
          <h2 className="panel__title">Your graph</h2>
          <p className="panel__caption">
            Live counts from the last crawl of each connected system.
          </p>
          <table className="dtable">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats?.nodes.byKind ?? {})
                .sort((a, b) => b[1] - a[1])
                .map(([kind, count]) => (
                  <tr key={kind}>
                    <td>{kind}</td>
                    <td className="mono">{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2 className="panel__title">Recent decisions</h2>
          <p className="panel__caption">
            Sample data — the verdict engine and its gates land with plans 7 and 8.
          </p>
          <table className="dtable">
            <thead>
              <tr>
                <th>Change</th>
                <th>Verdict</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.change}
                    {d.dryRun && (
                      <>
                        {" "}
                        <span className="tag tag--ghost">dry-run</span>
                      </>
                    )}
                  </td>
                  <td>
                    <VerdictBadge verdict={d.verdict} />
                  </td>
                  <td className="dim">{timeAgo(d.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
