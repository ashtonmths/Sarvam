"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Select } from "../../../components/app/select";
import { EmptyState, PageHead, VerdictBadge } from "../../../components/app/ui";
import {
  ApiError,
  api,
  type ExplanationState,
  type GraphNode,
  type Page,
  subscribe,
  type VerdictResult,
} from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * A thin client over the real engine, deliberately. The UI never computes or
 * approximates a verdict — it renders what the engine said, so a simulation is
 * exactly what enforcement would do.
 */

const OPERATIONS: Record<string, string[]> = {
  field: ["delete", "rename", "retype"],
  table: ["delete", "rename"],
  report: ["delete", "rename"],
  workflow: ["modify", "disable", "delete"],
  step: ["modify", "delete"],
  service: ["delete"],
  credential: ["revoke"],
  endpoint: ["rename"],
};

/** The engine's union: a change it cannot receive is not composable here. */
function targetFor(kind: string): "field" | "workflow" | "credential" {
  if (kind === "workflow" || kind === "step") return "workflow";
  if (kind === "credential") return "credential";
  return "field";
}

function SimulateInner() {
  const params = useSearchParams();
  const nodes = useQuery<Page<GraphNode>>("/api/graph/nodes?limit=200");

  const [nodeId, setNodeId] = useState<number | null>(null);
  const [operation, setOperation] = useState("delete");
  const [result, setResult] = useState<VerdictResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [explanation, setExplanation] = useState("");
  const [explState, setExplState] = useState<ExplanationState>("pending");
  const [resetAt, setResetAt] = useState<string | null>(null);

  const items = nodes.data?.items ?? [];
  const preselect = Number(params.get("node")) || null;

  useEffect(() => {
    if (nodeId === null && items.length > 0) {
      const wanted =
        preselect && items.some((n) => n.id === preselect) ? preselect : items[0]?.id;
      setNodeId(wanted ?? null);
    }
  }, [items, nodeId, preselect]);

  const selected = items.find((n) => n.id === nodeId) ?? null;
  const operations = selected ? (OPERATIONS[selected.kind] ?? ["delete"]) : ["delete"];

  /**
   * Derived, not synced through an effect. `operations` is a fresh array on
   * every render, so it can never be an honest dependency, and the effect
   * version rendered one frame with an operation the selected node does not
   * support before correcting itself. Picking a table after choosing "retype"
   * now falls back in the same render that changes the node.
   */
  const effectiveOperation = operations.includes(operation)
    ? operation
    : (operations[0] ?? "delete");

  async function run() {
    if (!selected) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setExplanation("");
    setExplState("pending");
    setResetAt(null);

    try {
      const verdict = await api.post<VerdictResult>("/api/verdicts", {
        target: targetFor(selected.kind),
        operation: effectiveOperation,
        connector: selected.connector,
        externalId: selected.externalId,
      });
      // The card renders the moment the response lands — no skeleton theater.
      setResult(verdict);
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "Could not reach the API");
    } finally {
      setRunning(false);
    }
  }

  /**
   * The explanation streams in additively, below a card that is already
   * complete. All five states are quiet one-liners in the same slot: no error
   * styling, no layout shift, and no retry button on quota_exhausted —
   * offering a retry against a daily cap is a lie the UI would be telling.
   */
  useEffect(() => {
    if (!result) return;
    return subscribe(`/api/verdicts/${result.id}/explanation`, {
      onEvent: (event, data) => {
        if (event === "delta") {
          setExplState("streamed");
          setExplanation((prev) => prev + String(data.text ?? ""));
        }
        if (event === "done") setExplState("streamed");
        if (event === "failed") setExplState("failed");
        if (event === "disabled") setExplState("disabled");
        if (event === "quota_exhausted") {
          setExplState("quota_exhausted");
          setResetAt((data.resetAt as string) ?? null);
        }
      },
      onError: () => setExplState((s) => (s === "pending" ? "failed" : s)),
    });
  }, [result]);

  if (!nodes.loading && items.length === 0) {
    return (
      <>
        <PageHead
          title="Simulate a change"
          sub="A dry-run through the same engine enforcement uses."
        />
        <EmptyState
          title="Nothing to simulate against"
          body="Simulation traverses your real graph — connect a system and the picker fills with your own tables, workflows and fields."
          action={{ href: "/app/settings/connectors", label: "Add a connector →" }}
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
          <Select
            value={String(nodeId ?? "")}
            onChange={(v) => setNodeId(Number(v))}
            label="Target"
            testid="simulate-node-picker"
            options={items.map((n) => ({
              value: String(n.id),
              label: `${n.name} · ${n.kind} · ${n.connector}`,
            }))}
          />
          <Select
            value={effectiveOperation}
            onChange={setOperation}
            label="Operation"
            testid="simulate-operation-picker"
            options={operations.map((op) => ({ value: op, label: op }))}
          />
          <button
            type="button"
            className="btn btn--ink"
            onClick={() => void run()}
            disabled={running || !selected}
            data-testid="simulate-run"
          >
            {running ? "Running…" : "Run dry-run"}
          </button>
        </div>
        {error && (
          <p
            style={{ color: "var(--block)", fontSize: 13.5, marginTop: 10 }}
            role="alert"
          >
            {error}
          </p>
        )}
      </div>

      {result && (
        <>
          <div className="banner banner--info" role="status">
            Simulation — recorded, excluded from enforcement metrics.
          </div>

          <div className="verdict-card" data-testid="simulate-verdict-card">
            <div className="verdict-card__head">
              <VerdictBadge verdict={result.verdict} big />
              <div>
                <strong style={{ fontSize: 16 }}>
                  {effectiveOperation} {selected?.name}
                </strong>
                <div className="dim" style={{ fontSize: 13 }}>
                  {result.impacted.length} downstream node
                  {result.impacted.length === 1 ? "" : "s"} scored
                </div>
              </div>
              <span className="verdict-card__timing">
                computed in {result.computedInMs}ms · no model in this path
              </span>
            </div>

            <div className="verdict-card__body">
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>Evidence</h3>
              {result.evidence.length === 0 ? (
                <p className="dim" style={{ fontSize: 14 }}>
                  Nothing downstream crosses a threshold.
                </p>
              ) : (
                <div className="evidence">
                  {result.evidence.map((ev, i) => (
                    <div key={i} className="evidence__row">
                      <Link
                        href="/app/graph"
                        style={{ fontWeight: 600, color: "var(--thread)" }}
                      >
                        {ev.name}
                      </Link>
                      <span className="evidence__rule">{ev.rule}</span>
                      <span className="evidence__impact">{ev.impact.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}

              {result.impacted.length > 0 && (
                <details style={{ marginTop: 14, fontSize: 13.5 }}>
                  <summary className="mono dim" style={{ cursor: "pointer" }}>
                    Full blast radius ({result.impacted.length} nodes)
                  </summary>
                  <table className="dtable" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th>Node</th>
                        <th>Hops</th>
                        <th>Path conf.</th>
                        <th>Min edge</th>
                        <th>Impact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.impacted.map((r) => (
                        <tr key={r.nodeId}>
                          <td>{r.name}</td>
                          <td className="mono">{r.hops}</td>
                          <td className="mono">{r.pathConfidence.toFixed(2)}</td>
                          <td className="mono">{r.minEdgeConfidence.toFixed(2)}</td>
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
                  {explanation}
                  <span className="explain__cursor" />
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
                  resume at{" "}
                  {resetAt ? new Date(resetAt).toLocaleString() : "the next reset"}.
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {!result && !running && (
        <div className="empty">
          <strong>Pick a target and run a dry-run</strong>
          <p>
            Try <em>delete</em> on <code className="mono">invoices.vat_rate</code> — the
            canonical BLOCK: <code className="mono">eu_vat_report</code> depends on it.
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
