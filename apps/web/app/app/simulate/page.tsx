"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Select } from "../../../components/app/select";
import { EmptyState, PageHead, VerdictBadge } from "../../../components/app/ui";
import { nodeById } from "../../../lib/mock/data";
import {
  OPERATIONS_BY_KIND,
  SIMULATABLE_NODES,
  type SimulatedDecision,
  simulate,
} from "../../../lib/mock/verdict";
import { useHasGraph } from "../../../lib/queries";
import { useSession } from "../../../lib/session";

/**
 * The explanation area renders exactly one of the five Plan 7 states. The
 * mock streams by default; the selector exists to drill the other four —
 * every state is a quiet one-line render in the same slot, never an error.
 */
type ExplanationState =
  | "pending"
  | "streamed"
  | "failed"
  | "disabled"
  | "quota_exhausted";

function SimulateInner() {
  const { org } = useSession();
  const { hasGraph } = useHasGraph(org?.id ?? null);
  const searchParams = useSearchParams();
  const preselect = Number(searchParams.get("node")) || SIMULATABLE_NODES[0]?.id || 1;

  const [nodeId, setNodeId] = useState(
    SIMULATABLE_NODES.some((n) => n.id === preselect)
      ? preselect
      : (SIMULATABLE_NODES[0]?.id ?? 1),
  );
  const [chosenOperation, setOperation] = useState<string>(
    () => OPERATIONS_BY_KIND[nodeById(preselect)?.kind ?? "field"]?.[0] ?? "delete",
  );
  const [decision, setDecision] = useState<SimulatedDecision | null>(null);
  const [explState, setExplState] = useState<ExplanationState>("pending");
  const [drill, setDrill] = useState<ExplanationState>("streamed");
  const [streamed, setStreamed] = useState("");
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const node = nodeById(nodeId);
  const operations = OPERATIONS_BY_KIND[node.kind] ?? ["delete"];

  /**
   * The node's kind decides which operations exist, so a choice carried over
   * from the previous node falls back rather than lingering as a value this
   * kind cannot do. Derived instead of synced in an effect: there is no frame
   * where the picker shows an operation that is not in its own list.
   */
  const operation = operations.includes(chosenOperation)
    ? chosenOperation
    : (operations[0] ?? "delete");

  useEffect(
    () => () => {
      if (streamTimer.current) clearInterval(streamTimer.current);
    },
    [],
  );

  function run() {
    if (streamTimer.current) clearInterval(streamTimer.current);
    const d = simulate(nodeId, operation);
    // The verdict renders the moment the response lands — never waits on prose.
    setDecision(d);
    setStreamed("");

    if (drill !== "streamed") {
      setExplState(drill);
      return;
    }
    setExplState("pending");
    const words = d.explanation.split(" ");
    let i = 0;
    streamTimer.current = setInterval(() => {
      i += 1;
      setStreamed(words.slice(0, i).join(" "));
      if (i === 1) setExplState("streamed");
      if (i >= words.length && streamTimer.current) {
        clearInterval(streamTimer.current);
        streamTimer.current = null;
      }
    }, 28);
  }

  if (!hasGraph) {
    return (
      <>
        <PageHead
          title="Simulate a change"
          sub="A dry-run through the same engine enforcement uses."
        />
        <EmptyState
          title="Nothing to simulate against"
          body="Simulation traverses your real graph — connect a system and the picker fills with your own tables, workflows and fields."
          action={{ href: "/app/onboarding", label: "Connect a system →" }}
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Simulate a change"
        sub="A dry-run through the same engine enforcement uses. The verdict below is exactly what the gate would say — the UI never approximates it."
      />

      <div className="panel" style={{ marginBottom: 18 }}>
        <div
          style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}
        >
          <div className="field-inline">
            <label htmlFor="sim-node">Target</label>
            <Select
              id="sim-node"
              value={String(nodeId)}
              onChange={(v) => setNodeId(Number(v))}
              testid="simulate-node-picker"
              options={SIMULATABLE_NODES.map((n) => ({
                value: String(n.id),
                label: `${n.name} · ${n.kind} · ${n.connector}`,
              }))}
            />
          </div>
          <div className="field-inline">
            <label htmlFor="sim-op">Operation</label>
            <Select
              id="sim-op"
              value={operation}
              onChange={setOperation}
              testid="simulate-operation-picker"
              options={operations.map((op) => ({ value: op, label: op }))}
            />
          </div>
          <div className="field-inline">
            <label htmlFor="sim-drill">Explainer drill (mock only)</label>
            <Select
              id="sim-drill"
              value={drill}
              onChange={(v) => setDrill(v as ExplanationState)}
              options={[
                { value: "streamed", label: "streamed (normal)" },
                { value: "failed", label: "failed" },
                { value: "disabled", label: "disabled" },
                { value: "quota_exhausted", label: "quota_exhausted" },
              ]}
            />
          </div>
          <button
            type="button"
            className="btn btn--ink"
            onClick={run}
            data-testid="simulate-run"
          >
            Run dry-run
          </button>
        </div>
      </div>

      {decision && (
        <>
          <div className="banner banner--info" role="status">
            Simulation — recorded, excluded from enforcement metrics.
          </div>

          <div className="verdict-card" data-testid="simulate-verdict-card">
            <div className="verdict-card__head">
              <VerdictBadge verdict={decision.result.verdict} big />
              <div>
                <strong style={{ fontSize: 16 }}>
                  {operation} {node.name}
                </strong>
                <div className="dim" style={{ fontSize: 13 }}>
                  {decision.result.impacted.length} downstream nodes scored
                </div>
              </div>
              <span className="verdict-card__timing">
                computed in {decision.result.computedInMs}ms · no model in this path
              </span>
            </div>

            <div className="verdict-card__body">
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>Evidence</h3>
              {decision.result.evidence.length === 0 ? (
                <p className="dim" style={{ fontSize: 14 }}>
                  Nothing downstream crosses a threshold. The full blast radius is listed
                  below.
                </p>
              ) : (
                <div className="evidence">
                  {decision.result.evidence.map((ev, i) => (
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

              {decision.result.impacted.length > 0 && (
                <details style={{ marginTop: 14, fontSize: 13.5 }}>
                  <summary className="mono dim" style={{ cursor: "pointer" }}>
                    Full blast radius ({decision.result.impacted.length} nodes)
                  </summary>
                  <table className="dtable" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th>Node</th>
                        <th>Hops</th>
                        <th>Path conf.</th>
                        <th>Impact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {decision.result.impacted.map((r) => (
                        <tr key={r.nodeId}>
                          <td>{r.name}</td>
                          <td className="mono">{r.hops}</td>
                          <td className="mono">{r.pathConfidence.toFixed(2)}</td>
                          <td className="mono">{r.impact.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>

            <div
              className="explain"
              aria-live="polite"
              data-testid="simulate-explanation"
            >
              {explState === "pending" && (
                <span className="explain__state">Explaining…</span>
              )}
              {explState === "streamed" && (
                <span>
                  {streamed}
                  {streamed !== decision.explanation && (
                    <span className="explain__cursor" />
                  )}
                </span>
              )}
              {explState === "failed" && (
                <span className="explain__state">
                  Explanation unavailable — the verdict above is complete without it.
                </span>
              )}
              {explState === "disabled" && (
                <span className="explain__state">
                  Explanations are turned off — the verdict above is complete without
                  them.
                </span>
              )}
              {explState === "quota_exhausted" && (
                <span className="explain__state">
                  Explanation unavailable — daily model quota exhausted. Explanations
                  resume at 00:00 UTC.
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {!decision && (
        <div className="empty">
          <strong>Pick a target and run a dry-run</strong>
          <p>
            Try <em>delete</em> on <code className="mono">invoices.vat_rate</code> — the
            canonical BLOCK: <code className="mono">eu_vat_report</code> depends on it and
            only Marcus ever explained why.
          </p>
        </div>
      )}
    </>
  );
}

export default function SimulatePage() {
  return (
    <Suspense fallback={null}>
      <SimulateInner />
    </Suspense>
  );
}
