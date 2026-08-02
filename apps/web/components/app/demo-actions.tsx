"use client";

import { PlayCircle, Workflow } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../lib/api";

/**
 * The demo, without a terminal.
 *
 * Both of these existed only as scripts, which is fine on a laptop and useless
 * on a hosted deployment — there is no shell to run them in, and "ssh in and
 * run this" is not a demo anyone can give. The work is identical: workflows are
 * created through n8n's own API, and the failure is a real execution that the
 * poller finds and the diagnosis explains.
 */

interface WorkflowResult {
  created: number;
  updated: number;
  nodes: number;
}

interface SimulateResult {
  failureId: number | null;
  state: string;
  diagnosis: {
    cause?: string;
    recommendation?: string;
    confidence?: number;
    impact?: { count: number };
    windowsSearched?: number;
    searchReach?: string;
    schemaChangeSuspected?: boolean;
  } | null;
}

export function DemoActions() {
  const [busy, setBusy] = useState<"create" | "simulate" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulateResult | null>(null);

  async function create() {
    setBusy("create");
    setError(null);
    setNote(null);
    try {
      const r = await api.post<WorkflowResult>("/api/n8n/demo/workflows");
      setNote(
        `${r.created} created, ${r.updated} updated — ${r.nodes} nodes on the map after crawling.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  async function simulate() {
    setBusy("simulate");
    setError(null);
    setNote(null);
    setResult(null);
    try {
      setResult(await api.post<SimulateResult>("/api/n8n/demo/simulate"));
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  const d = result?.diagnosis;

  return (
    <div className="demo">
      <p className="panel__caption">
        Four workflows in your own n8n, then one broken on purpose. The failure is a real
        execution — n8n runs it, it throws, and everything after that is the path a
        genuine failure takes.
      </p>

      <div className="demo__row">
        <button
          type="button"
          className="btn btn--ink"
          disabled={busy !== null}
          onClick={() => void create()}
          data-testid="demo-create-workflows"
        >
          <Workflow size={15} strokeWidth={2} aria-hidden />
          {busy === "create" ? "Creating…" : "Create demo workflows"}
        </button>

        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy !== null}
          onClick={() => void simulate()}
          data-testid="demo-simulate-failure"
        >
          <PlayCircle size={15} strokeWidth={2} aria-hidden />
          {busy === "simulate" ? "Running and diagnosing…" : "Break one and diagnose it"}
        </button>
      </div>

      {note && <p className="demo__note">{note}</p>}

      {error && (
        <div className="banner banner--warn" role="status">
          {error}
        </div>
      )}

      {result && (
        <div className="demo__result">
          {result.failureId === null ? (
            <p className="dim">
              n8n ran it but no failed execution was captured. Check the workflow in n8n.
            </p>
          ) : (
            <>
              <div className="demo__meta">
                <span>
                  failure <strong>#{result.failureId}</strong>
                </span>
                <span>{result.state}</span>
                {d?.confidence !== undefined && (
                  <span>{Math.round(d.confidence * 100)}% confident</span>
                )}
                {d?.schemaChangeSuspected && (
                  <span className="tag tag--amber">schema change</span>
                )}
              </div>

              {d?.recommendation && (
                <>
                  <h4 className="demo__head">What to do</h4>
                  <p className="demo__text">{d.recommendation}</p>
                </>
              )}
              {d?.cause && (
                <>
                  <h4 className="demo__head">Why</h4>
                  <p className="demo__text">{d.cause}</p>
                </>
              )}
              {d?.searchReach && (
                <p className="demo__reach">
                  Searched {d.windowsSearched} window
                  {d.windowsSearched === 1 ? "" : "s"} — {d.searchReach}
                </p>
              )}
              <p className="demo__note">
                <a href={`/app/workflows/${result.failureId}`}>
                  See the full diagnosis →
                </a>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
