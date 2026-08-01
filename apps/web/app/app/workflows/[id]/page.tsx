"use client";

import { use } from "react";
import { PageHead } from "../../../../components/app/ui";
import { useQuery } from "../../../../lib/queries";

/**
 * What the Slack alert's button opens.
 *
 * The alert is deliberately three lines, which only works if the evidence is
 * one click away and complete: what broke, who it broke for, how far back the
 * search reached, and what the conclusion rests on. A recommendation nobody can
 * check is a recommendation nobody should act on — and this one was written by
 * a model, which makes checkable the whole point rather than a nicety.
 */

interface Diagnosis {
  impact: { count: number; top: Array<{ name: string; kind: string; hops: number }> };
  cause: string;
  recommendation: string;
  confidence: number;
  evidence: Array<{ source: string; detail: string }>;
  windowsSearched: number;
  searchReach?: string;
  schemaChangeSuspected: boolean;
}

interface Failure {
  id: number;
  workflowId: string;
  workflowName: string | null;
  failedNode: string | null;
  errorMessage: string | null;
  mode: string | null;
  detectPath: string;
  startedAt: string | null;
  stoppedAt: string | null;
  detectedAt: string;
  diagnosisState: string;
  diagnosisError: string | null;
  diagnosis: Diagnosis | null;
}

function confidenceLabel(value: number): string {
  if (value >= 0.8) return "High confidence";
  if (value >= 0.6) return "Probable";
  return "Best guess";
}

/** Each state means something different happened, so each says so plainly. */
const STATE_COPY: Record<string, string> = {
  captured: "Detected. The diagnosis has not run yet.",
  unrelated: "Nothing we shipped in the searched window explains this failure.",
  fix_pending: "A pull request is already open on the code that changed.",
  diagnosed: "Diagnosed from the changes in the window.",
  failed: "The diagnosis could not complete.",
};

export default function WorkflowFailurePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const detail = useQuery<{ failure: Failure }>(`/api/n8n/failures/${id}`, [id]);

  if (detail.error) {
    return (
      <div className="banner banner--warn" role="status">
        That workflow failure does not exist, or it belongs to another organisation.
      </div>
    );
  }
  if (!detail.data) return <p className="dim">Loading…</p>;

  const f = detail.data.failure;
  const d = f.diagnosis;
  const failedAt = f.stoppedAt ?? f.startedAt ?? f.detectedAt;

  return (
    <>
      <PageHead
        title={f.workflowName ?? f.workflowId}
        sub={
          <>
            {f.failedNode ? `failed at ${f.failedNode} · ` : ""}
            {new Date(failedAt).toLocaleString()}
            {f.mode ? ` · ${f.mode}` : ""} · detected by {f.detectPath}
          </>
        }
      />

      <div className="mx-hero">
        <div className="mx-fig" data-tone={d && d.impact.count > 0 ? "block" : "ink"}>
          <span className="mx-fig__value">{d?.impact.count ?? 0}</span>
          <span className="mx-fig__label">dependants affected</span>
        </div>
        <div className="mx-fig" data-tone="ink">
          <span className="mx-fig__value">{d?.windowsSearched ?? 0}</span>
          <span className="mx-fig__label">windows searched</span>
          {d?.searchReach && <span className="mx-fig__note">{d.searchReach}</span>}
        </div>
        <div className="mx-fig" data-tone={d?.schemaChangeSuspected ? "warn" : "ink"}>
          <span className="mx-fig__value">{d?.schemaChangeSuspected ? "yes" : "no"}</span>
          <span className="mx-fig__label">schema change in window</span>
        </div>
        <div className="mx-fig" data-tone="thread">
          <span className="mx-fig__value">
            {d ? `${Math.round(d.confidence * 100)}%` : "—"}
          </span>
          <span className="mx-fig__label">confidence</span>
          {d && <span className="mx-fig__note">{confidenceLabel(d.confidence)}</span>}
        </div>
      </div>

      <section className="panel mx-panel">
        <p className="panel__caption">
          {STATE_COPY[f.diagnosisState] ?? f.diagnosisState}
        </p>

        {d ? (
          <>
            <h2 className="ci__heading">What to do</h2>
            <p className="ci__recommendation">{d.recommendation}</p>

            <h2 className="ci__heading">Why</h2>
            <p className="ci__cause">{d.cause}</p>

            {d.evidence.length > 0 && (
              <>
                <h2 className="ci__heading">Evidence</h2>
                <ul className="ci__evidence">
                  {d.evidence.map((item) => (
                    <li
                      key={`${item.source}:${item.detail}`}
                      className="ci__evidence-item"
                    >
                      <span className="ci__evidence-source">{item.source}</span>
                      <span>{item.detail}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="dim">
            {f.diagnosisError
              ? `The diagnosis stopped: ${f.diagnosisError}`
              : "Nothing has been worked out about this failure yet."}
          </p>
        )}
      </section>

      {d && d.impact.count > 0 && (
        <section className="panel mx-panel">
          <h2 className="ci__heading">What depends on this workflow</h2>
          <ul className="mx-prov">
            {d.impact.top.map((node) => (
              <li className="ci__evidence-item" key={node.name}>
                <span className="ci__evidence-source">{node.kind}</span>
                <span>
                  {node.name} · {node.hops} hop{node.hops === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel mx-panel">
        <h2 className="ci__heading">The error n8n reported</h2>
        {f.errorMessage ? (
          <pre className="ci__log">{f.errorMessage}</pre>
        ) : (
          <p className="dim">n8n recorded no error message for this execution.</p>
        )}
      </section>
    </>
  );
}
