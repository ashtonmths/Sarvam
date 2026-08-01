"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState, PageHead } from "../../../components/app/ui";
import { AGENT_RUNS, timeAgo } from "../../../lib/mock/data";
import { useHasGraph } from "../../../lib/queries";
import { useSession } from "../../../lib/session";

const OUTCOME_TAG: Record<string, { cls: string; label: string }> = {
  propose_rationale: { cls: "tag--green", label: "proposed rationale" },
  draft_correction: { cls: "tag--green", label: "drafted correction" },
  // give_up / dismiss are amber, never red — declining to confabulate is
  // correct behavior and the UI says so.
  give_up: { cls: "tag--amber", label: "gave up" },
  dismiss: { cls: "tag--amber", label: "dismissed" },
  running: { cls: "tag--thread", label: "running" },
};

export default function AgentsPage() {
  const { org } = useSession();
  const { hasGraph } = useHasGraph(org?.id ?? null);
  const [agent, setAgent] = useState("all");
  const [outcome, setOutcome] = useState("all");

  if (!hasGraph) {
    return (
      <>
        <PageHead
          title="Agents"
          sub="Every investigation, live or replayed from its trace."
        />
        <EmptyState
          title="No investigations yet"
          body="Historian starts explaining edges once a graph exists, and Reviewer wakes when a subgraph's hash changes. Both leave a full trace here."
          action={{ href: "/app/onboarding", label: "Connect a system →" }}
        />
      </>
    );
  }

  const rows = AGENT_RUNS.filter((r) => {
    if (agent !== "all" && r.agent !== agent) return false;
    if (outcome !== "all" && r.outcome !== outcome) return false;
    return true;
  });

  return (
    <>
      <PageHead
        title="Agents"
        sub="Every investigation, live or replayed from its trace. Giving up is rendered amber, not red — an honest non-answer beats a confabulated one."
      >
        <Link
          href="/app/agents/departure"
          className="btn btn--ink btn--small"
          data-testid="agents-departure-cta"
        >
          Exit-interview fan-out
        </Link>
      </PageHead>

      <div className="filters">
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          aria-label="Filter by agent"
        >
          <option value="all">Historian + Reviewer</option>
          <option value="historian">Historian</option>
          <option value="reviewer">Reviewer</option>
        </select>
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          aria-label="Filter by outcome"
        >
          <option value="all">All outcomes</option>
          <option value="propose_rationale">proposed rationale</option>
          <option value="draft_correction">drafted correction</option>
          <option value="give_up">gave up</option>
          <option value="dismiss">dismissed</option>
        </select>
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table className="dtable">
          <thead>
            <tr>
              <th>Goal</th>
              <th>Agent</th>
              <th>Outcome</th>
              <th>Steps</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = OUTCOME_TAG[r.outcome] ?? { cls: "tag--ghost", label: r.outcome };
              return (
                <tr key={r.id} data-testid={`agent-run-${r.id}`}>
                  <td>
                    <Link
                      href={`/app/agents/${r.id}`}
                      style={{ fontWeight: 600, color: "var(--thread)" }}
                    >
                      {r.goal}
                    </Link>
                    <div className="dim" style={{ fontSize: 12.5 }}>
                      {r.outcomeDetail}
                    </div>
                  </td>
                  <td className="mono dim">{r.agent}</td>
                  <td>
                    <span className={`tag ${t.cls}`}>{t.label}</span>
                  </td>
                  <td className="mono">{r.steps.length}</td>
                  <td className="mono dim">{Math.round(r.durationMs / 1000)}s</td>
                  <td className="dim">{timeAgo(r.startedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
