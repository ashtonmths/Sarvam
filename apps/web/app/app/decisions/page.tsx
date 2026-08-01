"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Select } from "../../../components/app/select";
import { EmptyState, PageHead, VerdictBadge } from "../../../components/app/ui";
import { DECISIONS, fmtDate, nodeById } from "../../../lib/mock/data";
import { verdict as computeVerdict, traverse } from "../../../lib/mock/verdict";
import { useHasGraph } from "../../../lib/queries";
import { useSession } from "../../../lib/session";

export default function DecisionsPage() {
  const { org } = useSession();
  const { hasGraph } = useHasGraph(org?.id ?? null);
  const [mode, setMode] = useState("all");
  const [v, setV] = useState("all");
  const [dry, setDry] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      (hasGraph ? DECISIONS : []).filter((d) => {
        if (mode !== "all" && d.mode !== mode) return false;
        if (v !== "all" && d.verdict !== v) return false;
        if (dry === "live" && d.dryRun) return false;
        if (dry === "dry" && !d.dryRun) return false;
        return true;
      }),
    [hasGraph, mode, v, dry],
  );

  if (!hasGraph) {
    return (
      <>
        <PageHead
          title="Decisions"
          sub="Every verdict the engine issues lands here with its evidence."
        />
        <EmptyState
          title="No decisions yet"
          body="The first entry appears the moment you run a simulation — or the moment enforcement gates a real change."
          action={{ href: "/app/onboarding", label: "Get to your first verdict →" }}
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Decisions"
        sub={
          <>
            Every verdict the engine has issued, with its evidence as it stood at decision
            time. This is the &ldquo;why did you block my change?&rdquo; answer page.
          </>
        }
      />

      <div className="filters">
        <Select
          value={mode}
          onChange={setMode}
          label="Filter by mode"
          options={[
            { value: "all", label: "All modes" },
            { value: "hard-gate", label: "Hard gate (GitHub)" },
            { value: "proxy-gate", label: "Proxy gate (REST)" },
            { value: "mcp", label: "MCP (AI agents)" },
            { value: "reflex", label: "Reflex (post-change)" },
            { value: "simulation", label: "Simulation" },
          ]}
        />
        <Select
          value={v}
          onChange={setV}
          label="Filter by verdict"
          options={[
            { value: "all", label: "All verdicts" },
            { value: "BLOCK", label: "BLOCK" },
            { value: "WARN", label: "WARN" },
            { value: "APPROVE", label: "APPROVE" },
          ]}
        />
        <Select
          value={dry}
          onChange={setDry}
          label="Filter dry-run"
          options={[
            { value: "all", label: "Live + dry-run" },
            { value: "live", label: "Enforced only" },
            { value: "dry", label: "Dry-runs only" },
          ]}
        />
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table className="dtable dtable--click">
          <thead>
            <tr>
              <th>Change</th>
              <th>Verdict</th>
              <th>Mode</th>
              <th>Actor</th>
              <th>Compute</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <>
                <tr
                  key={d.id}
                  data-selected={openId === d.id}
                  onClick={() => setOpenId(openId === d.id ? null : d.id)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && setOpenId(openId === d.id ? null : d.id)
                  }
                  tabIndex={0}
                  data-testid={`decision-row-${d.id}`}
                >
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
                  <td className="mono dim">{d.mode}</td>
                  <td className="dim" style={{ overflowWrap: "anywhere" }}>
                    {d.actor}
                  </td>
                  <td className="mono dim">{d.computedInMs}ms</td>
                  <td className="dim" style={{ whiteSpace: "nowrap" }}>
                    {fmtDate(d.at)}
                  </td>
                </tr>
                {openId === d.id && (
                  <tr key={`${d.id}-detail`}>
                    <td colSpan={6} style={{ background: "var(--panel)" }}>
                      <DecisionDetail targetNodeId={d.targetNodeId} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="empty" style={{ margin: 16 }}>
            <strong>No decisions match these filters</strong>
            <p>Loosen a filter, or run a simulation to add one.</p>
          </div>
        )}
      </div>
    </>
  );
}

function DecisionDetail({ targetNodeId }: { targetNodeId: number }) {
  // The stored evidence snapshot; the mock recomputes it, the real API replays it.
  const impacted = traverse(targetNodeId);
  const { evidence } = computeVerdict(impacted);
  const node = nodeById(targetNodeId);

  return (
    <div style={{ padding: "6px 4px" }}>
      <p className="mono dim" style={{ fontSize: 11.5, marginBottom: 8 }}>
        Evidence snapshot for {node.externalId}
      </p>
      {evidence.length === 0 ? (
        <p className="dim" style={{ fontSize: 13.5 }}>
          Nothing crossed a threshold — approved without conditions.
        </p>
      ) : (
        <div className="evidence">
          {evidence.map((ev, i) => (
            <div key={i} className="evidence__row">
              {ev.nodeId > 0 ? (
                <Link
                  href="/app/graph"
                  style={{ fontWeight: 600, color: "var(--thread)" }}
                >
                  {ev.name}
                </Link>
              ) : (
                <strong>{ev.name}</strong>
              )}
              <span className="evidence__rule">{ev.rule}</span>
              <span className="evidence__impact">{ev.impact.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
