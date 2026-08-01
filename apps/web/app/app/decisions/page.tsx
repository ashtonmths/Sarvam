"use client";

import { Fragment, useState } from "react";
import { Select } from "../../../components/app/select";
import { EmptyState, PageHead, VerdictBadge } from "../../../components/app/ui";
import { api, type DecisionDetail, type DecisionRow, type Page } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/** The "why did you block my change?" answer page, over the real decision log. */
export default function DecisionsPage() {
  const [mode, setMode] = useState("all");
  const [verdict, setVerdict] = useState("all");
  const [dryRun, setDryRun] = useState("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);

  const query = new URLSearchParams({ limit: "50" });
  if (mode !== "all") query.set("mode", mode);
  if (verdict !== "all") query.set("verdict", verdict);
  if (dryRun !== "all") query.set("dry_run", dryRun);

  const decisions = useQuery<Page<DecisionRow>>(`/api/gate/decisions?${query}`, [
    mode,
    verdict,
    dryRun,
  ]);

  async function open(id: number) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    try {
      setDetail(await api.get<DecisionDetail>(`/api/gate/decisions/${id}`));
    } catch {
      setDetail(null);
    }
  }

  const rows = decisions.data?.items ?? [];

  return (
    <>
      <PageHead
        title="Decisions"
        sub="Every verdict the engine has issued, with its evidence as it stood at decision time."
      />

      <div className="filters">
        <Select
          value={mode}
          onChange={setMode}
          label="Filter by mode"
          options={[
            { value: "all", label: "All modes" },
            { value: "hard_gate", label: "Hard gate (GitHub)" },
            { value: "proxy_gate", label: "Proxy gate (REST)" },
            { value: "mcp", label: "MCP (AI agents)" },
            { value: "forward", label: "Forwarded" },
          ]}
        />
        <Select
          value={verdict}
          onChange={setVerdict}
          label="Filter by verdict"
          options={[
            { value: "all", label: "All verdicts" },
            { value: "BLOCK", label: "BLOCK" },
            { value: "WARN", label: "WARN" },
            { value: "APPROVE", label: "APPROVE" },
          ]}
        />
        <Select
          value={dryRun}
          onChange={setDryRun}
          label="Filter dry-run"
          options={[
            { value: "all", label: "Live + dry-run" },
            { value: "false", label: "Enforced only" },
            { value: "true", label: "Dry-runs only" },
          ]}
        />
      </div>

      {decisions.loading ? (
        <div className="panel" style={{ height: 200, opacity: 0.4 }} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No decisions yet"
          body="The first entry appears the moment you run a simulation — or the moment enforcement gates a real change."
          action={{ href: "/app/simulate", label: "Run a simulation →" }}
        />
      ) : (
        <div className="panel panel--table">
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
              {rows.map((row) => (
                // The key belongs on the fragment, not on the rows inside it:
                // a row and its expanded detail are two siblings from one
                // item, so the fragment is what React is reconciling.
                <Fragment key={row.id}>
                  <tr
                    data-selected={openId === row.id}
                    onClick={() => void open(row.id)}
                    onKeyDown={(e) => e.key === "Enter" && void open(row.id)}
                    tabIndex={0}
                    data-testid={`decision-row-${row.id}`}
                  >
                    <td>
                      {row.change.operation}{" "}
                      {String(row.change.externalId ?? "")
                        .split("/")
                        .pop()}
                      {row.dryRun && (
                        <>
                          {" "}
                          <span className="tag tag--ghost">dry-run</span>
                        </>
                      )}
                    </td>
                    <td>
                      <VerdictBadge verdict={row.verdict} />
                    </td>
                    <td className="mono dim">{row.mode}</td>
                    <td className="dim" style={{ overflowWrap: "anywhere" }}>
                      {row.actor}
                    </td>
                    <td className="mono dim">{row.computedInMs}ms</td>
                    <td className="dim" style={{ whiteSpace: "nowrap" }}>
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                  </tr>
                  {openId === row.id && (
                    <tr>
                      <td colSpan={6} style={{ background: "var(--panel)" }}>
                        {!detail ? (
                          <p className="dim" style={{ fontSize: 13 }}>
                            Loading the evidence snapshot…
                          </p>
                        ) : (
                          <div style={{ padding: "6px 4px" }}>
                            <p
                              className="mono dim"
                              style={{ fontSize: 11.5, marginBottom: 8 }}
                            >
                              Evidence as it stood at decision time · graph version{" "}
                              {detail.graphVersion}
                            </p>
                            {detail.evidence.length === 0 ? (
                              <p className="dim" style={{ fontSize: 13.5 }}>
                                Nothing crossed a threshold.
                              </p>
                            ) : (
                              <div className="evidence">
                                {detail.evidence.map((ev, i) => (
                                  <div key={i} className="evidence__row">
                                    <strong>{ev.name}</strong>
                                    <span className="evidence__rule">{ev.rule}</span>
                                    <span className="evidence__impact">
                                      {ev.impact.toFixed(2)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {detail.explanation && (
                              <p
                                style={{
                                  fontSize: 13.5,
                                  marginTop: 10,
                                  color: "var(--ink-soft)",
                                }}
                              >
                                {detail.explanation}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
