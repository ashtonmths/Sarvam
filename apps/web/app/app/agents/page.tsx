"use client";

import Link from "next/link";
import { EmptyState, PageHead } from "../../../components/app/ui";
import type { HistorianRun } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * Every investigation, with its outcome stated honestly.
 *
 * `gave up` renders amber, never red: declining to confabulate is correct
 * behaviour, and an honest "unexplained" is worth more than a plausible lie.
 */
export default function AgentsPage() {
  const runs = useQuery<{ items: HistorianRun[] }>("/api/historian/runs");
  const quota = useQuery<{ remaining: number }>("/api/historian/quota");
  const unexplained = useQuery<{ items: Array<{ edgeId: number }> }>(
    "/api/rationale/unexplained",
  );

  const items = runs.data?.items ?? [];
  const pending = unexplained.data?.items.length ?? 0;

  return (
    <>
      <PageHead
        title="Agents"
        sub="Historian investigates why a dependency exists, using only written evidence it can cite. Giving up is a correct answer, not a failure."
      >
        <span className="tag tag--thread">
          {quota.data?.remaining ?? "—"} model requests left today
        </span>
      </PageHead>

      <div className="panel-grid panel-grid--2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <h2 className="panel__title">Exit interview</h2>
          <p className="panel__caption">
            When someone leaves, the edges only they ever explained become unexplained.
            Investigate them while the written trail still exists.
          </p>
          <Link href="/app/agents/departure" className="btn btn--ghost btn--small">
            Start an exit interview →
          </Link>
        </section>

        <section className="panel">
          <h2 className="panel__title">Unexplained edges</h2>
          <p className="panel__caption">Historian&rsquo;s worklist.</p>
          <div className="stat">
            <span className="stat__value">{pending}</span>
            <span className="stat__hint">dependencies with no rationale linked yet</span>
          </div>
        </section>
      </div>

      {runs.loading ? (
        <div className="panel" style={{ height: 160, opacity: 0.4 }} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No investigations yet"
          body="Historian runs after a crawl, or when you start an exit interview above. Every tool call it makes is recorded, so you can see exactly how it reached a conclusion."
        />
      ) : (
        <div className="panel panel--table">
          <table className="dtable">
            <thead>
              <tr>
                <th>Run</th>
                <th>State</th>
                <th>Outcome</th>
                <th>Requests</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => (
                <tr key={run.id} data-testid={`agent-run-${run.id}`}>
                  <td>
                    <Link
                      href={`/app/agents/${run.id}`}
                      style={{ fontWeight: 600, color: "var(--thread)" }}
                    >
                      {run.kind === "exit_interview"
                        ? "Exit interview"
                        : "Edge investigation"}
                    </Link>
                    <div className="dim" style={{ fontSize: 12.5 }}>
                      {run.edgesTotal} edge{run.edgesTotal === 1 ? "" : "s"} · started by{" "}
                      {run.startedBy ?? "system"}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`tag ${run.state === "done" ? "tag--green" : run.state === "cancelled" ? "tag--amber" : "tag--thread"}`}
                    >
                      {run.state}
                    </span>
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {run.edgesProposed > 0 && (
                      <span className="tag tag--green" style={{ marginRight: 4 }}>
                        {run.edgesProposed} drafted
                      </span>
                    )}
                    {run.edgesGaveUp > 0 && (
                      <span className="tag tag--amber" style={{ marginRight: 4 }}>
                        {run.edgesGaveUp} gave up
                      </span>
                    )}
                    {run.edgesSkippedQuota > 0 && (
                      <span className="tag tag--ghost">
                        {run.edgesSkippedQuota} skipped: quota
                      </span>
                    )}
                  </td>
                  <td className="mono dim">{run.requestsUsed}</td>
                  <td className="dim">{new Date(run.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
