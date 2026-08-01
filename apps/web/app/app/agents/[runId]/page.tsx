"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PageHead } from "../../../../components/app/ui";
import { type HistorianRun, type RunEdge, subscribe } from "../../../../lib/api";
import { useQuery } from "../../../../lib/queries";

interface TraceEvent {
  loopRunId: string;
  step: number;
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

/**
 * The reasoning path, as a product surface rather than a log.
 *
 * One component for live and finished runs: a terminal run replays its stored
 * trace at zero model cost, so a repeat demo is free. `give_up` is amber, with
 * its reason inline — the reviewer needs to see *why* an edge came back
 * unexplained.
 */
export default function TracePage() {
  const { runId } = useParams<{ runId: string }>();
  const run = useQuery<{ run: HistorianRun; edges: RunEdge[] }>(
    `/api/historian/runs/${runId}`,
  );
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [finished, setFinished] = useState(false);

  const state = run.data?.run.state;
  const terminal = state === "done" || state === "cancelled";

  useEffect(() => {
    if (!runId || state === undefined) return;
    // A finished run replays; a running one opens a live stream. Same events,
    // same rendering, one code path.
    const path = `/api/historian/runs/${runId}/events${terminal ? "?replay=1" : ""}`;
    return subscribe(path, {
      onEvent: (event, data) => {
        if (event === "trace")
          setEvents((prev) => [...prev, data as unknown as TraceEvent]);
        if (event === "run") {
          setFinished(true);
          run.reload();
        }
      },
      onError: () => setFinished(true),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, state, terminal]);

  if (run.loading) {
    return (
      <>
        <PageHead title="Investigation" />
        <div className="panel" style={{ height: 240, opacity: 0.4 }} />
      </>
    );
  }

  if (!run.data) {
    return (
      <>
        <PageHead title="Run not found" />
        <div className="empty">
          <strong>No run with that id</strong>
          <p>
            <Link href="/app/agents">Back to the run list →</Link>
          </p>
        </div>
      </>
    );
  }

  const { run: meta, edges } = run.data;
  const byLoop = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const bucket = byLoop.get(event.loopRunId);
    if (bucket) bucket.push(event);
    else byLoop.set(event.loopRunId, [event]);
  }

  return (
    <>
      <PageHead
        title={meta.kind === "exit_interview" ? "Exit interview" : "Edge investigation"}
        sub={
          <>
            <span className="mono">{meta.id.slice(0, 8)}</span> · {meta.edgesTotal} edge
            {meta.edgesTotal === 1 ? "" : "s"} · {meta.requestsUsed} model requests ·{" "}
            {meta.state}
          </>
        }
      >
        <Link href="/app/agents" className="btn btn--ghost btn--small">
          ← All runs
        </Link>
      </PageHead>

      {terminal && (
        <div className="banner banner--info" role="status">
          {meta.edgesProposed} draft{meta.edgesProposed === 1 ? "" : "s"} queued for your
          review · {meta.edgesGaveUp} honestly unexplained
          {meta.edgesSkippedQuota > 0 && (
            <>
              {" "}
              · {meta.edgesSkippedQuota} skipped: daily model quota, resumable tomorrow
            </>
          )}
          {" — drafts do not count toward coverage until a human confirms them."}
        </div>
      )}

      <div className="fanout-grid">
        {edges.map((edge) => {
          const steps = edge.loopRunId ? (byLoop.get(edge.loopRunId) ?? []) : [];
          const outcome = edge.outcome;
          return (
            <div
              key={edge.edgeId}
              className={`fanout-card${
                outcome === "proposed"
                  ? " fanout-card--green"
                  : outcome === "gave_up"
                    ? " fanout-card--amber"
                    : outcome === "skipped_quota"
                      ? " fanout-card--skipped"
                      : ""
              }`}
              data-testid={`run-edge-${edge.edgeId}`}
            >
              <span className="fanout-card__edge">edge #{edge.edgeId}</span>

              {!outcome && (
                <div className="fanout-card__stream">
                  <span className="pulse-dot" aria-hidden="true" />
                  investigating…
                </div>
              )}

              {steps.length > 0 && (
                <div className="fanout-card__stream" aria-live="polite">
                  {steps.slice(-4).map((step) => (
                    <div key={step.step} className="mono" style={{ fontSize: 11 }}>
                      {step.step}. {step.tool}
                    </div>
                  ))}
                </div>
              )}

              {outcome === "proposed" && (
                <>
                  <span className="tag tag--green">draft queued</span>
                  <Link
                    href="/app/queue"
                    style={{
                      fontSize: 13,
                      color: "var(--thread)",
                      textDecoration: "underline",
                    }}
                  >
                    Review in queue →
                  </Link>
                </>
              )}
              {outcome === "gave_up" && (
                <>
                  <span className="tag tag--amber">gave up</span>
                  <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                    No written trace found — declining to guess. The edge stays honestly
                    unexplained.
                  </span>
                </>
              )}
              {outcome === "skipped_quota" && (
                <>
                  <span className="tag tag--ghost">skipped: daily model quota</span>
                  <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                    Nothing was investigated, so nothing was given up. Resumable tomorrow.
                  </span>
                </>
              )}
              {outcome === "error" && <span className="tag tag--red">error</span>}
            </div>
          );
        })}
      </div>

      {events.length > 0 && (
        <section className="panel" style={{ marginTop: 18 }}>
          <h2 className="panel__title">Every tool call</h2>
          <p className="panel__caption">
            The full reasoning path, replayed from storage. This is what makes a
            conclusion auditable rather than asserted.
          </p>
          <div aria-live="polite" data-testid="trace-steps">
            {events.map((event, i) => (
              <div key={`${event.loopRunId}-${event.step}-${i}`} className="trace-card">
                <span className="trace-card__n">{event.step}</span>
                <div>
                  <span className="trace-card__tool">{event.tool}</span>{" "}
                  <span className="trace-card__args">
                    {JSON.stringify(event.input).slice(0, 120)}
                  </span>
                  <div className="trace-card__result">
                    {JSON.stringify(event.output).slice(0, 240)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!finished && !terminal && (
        <p className="dim" style={{ fontSize: 13, marginTop: 12 }}>
          <span className="pulse-dot" aria-hidden="true" />
          Streaming live…
        </p>
      )}
    </>
  );
}
