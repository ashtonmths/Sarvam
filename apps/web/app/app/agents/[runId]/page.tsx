"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PageHead } from "../../../../components/app/ui";
import { AGENT_RUNS, fmtDate } from "../../../../lib/mock/data";

/**
 * One component for live and finished runs — the plan's rule. The mock
 * "streams" the replay in step by step; a finished run and a live one render
 * identically because they are the same shape.
 */
export default function TracePage() {
  const { runId } = useParams<{ runId: string }>();
  const run = AGENT_RUNS.find((r) => r.id === runId);
  const [shown, setShown] = useState(1);

  useEffect(() => {
    if (!run) return;
    setShown(1);
    const t = setInterval(() => {
      setShown((s) => {
        if (s >= run.steps.length) {
          clearInterval(t);
          return s;
        }
        return s + 1;
      });
    }, 550);
    return () => clearInterval(t);
  }, [run]);

  if (!run) {
    return (
      <>
        <PageHead title="Trace not found" />
        <div className="empty">
          <strong>No run with id {runId}</strong>
          <p>
            <Link href="/app/agents">Back to the run list →</Link>
          </p>
        </div>
      </>
    );
  }

  const streaming = shown < run.steps.length;
  const amber = run.outcome === "give_up" || run.outcome === "dismiss";

  return (
    <>
      <PageHead
        title={run.goal}
        sub={
          <>
            <span className="mono">{run.id}</span> · {run.agent} · started{" "}
            {fmtDate(run.startedAt)} · {Math.round(run.durationMs / 1000)}s
          </>
        }
      >
        <Link href="/app/agents" className="btn btn--ghost btn--small">
          ← All runs
        </Link>
      </PageHead>

      <div aria-live="polite" data-testid="trace-steps">
        {run.steps.slice(0, shown).map((s) => (
          <div key={s.step} className="trace-card">
            <span className="trace-card__n">{s.step}</span>
            <div>
              <span className="trace-card__tool">{s.tool}</span>{" "}
              <span className="trace-card__args">{s.args}</span>
              <div className="trace-card__result">{s.result}</div>
            </div>
            <span className="trace-card__ms">{s.elapsedMs}ms</span>
          </div>
        ))}
      </div>

      {streaming ? (
        <p className="dim" style={{ fontSize: 13, marginTop: 12 }}>
          <span className="pulse-dot" aria-hidden="true" />
          Replaying from agent_traces…
        </p>
      ) : (
        <div
          className={`banner ${amber ? "banner--warn" : "banner--info"}`}
          style={{ marginTop: 14 }}
          role="status"
        >
          Terminal state: <strong>{run.outcome}</strong> — {run.outcomeDetail}
          {run.outcome === "propose_rationale" && (
            <Link
              href="/app/queue"
              style={{ textDecoration: "underline", marginLeft: 6 }}
            >
              Review the draft →
            </Link>
          )}
          {run.outcome === "draft_correction" && (
            <Link
              href="/app/queue"
              style={{ textDecoration: "underline", marginLeft: 6 }}
            >
              Review the correction →
            </Link>
          )}
        </div>
      )}
    </>
  );
}
