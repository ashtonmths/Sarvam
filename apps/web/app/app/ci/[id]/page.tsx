"use client";

import { use } from "react";
import { PageHead } from "../../../../components/app/ui";
import { useQuery } from "../../../../lib/queries";

/**
 * What the Slack alert's button opens.
 *
 * The alert is short on purpose, which only works if this page is complete.
 * Everything the conclusion rests on is here and nothing is summarised away:
 * the log that failed, the files the merge touched, the evidence cited, and
 * every earlier time this broke. A reader who cannot check the reasoning has
 * been asked to trust it, and an automated finding is exactly the kind that
 * should not be trusted on its own authority.
 */

interface Evidence {
  source: string;
  detail: string;
}

interface Precedent {
  id: number;
  headSha: string;
  createdAt: string;
  jobName: string | null;
  recommendation: string | null;
  htmlUrl: string;
}

interface Analysis {
  cause: string;
  recommendation: string;
  confidence: number;
  evidence: Evidence[];
  inconclusive?: boolean;
  quickFix?: boolean;
  quickLabel?: string;
  precedent?: Precedent[];
  paths?: string[];
}

interface Failure {
  id: number;
  owner: string;
  repo: string;
  runId: number;
  headSha: string;
  branch: string;
  workflowName: string;
  jobName: string | null;
  stepName: string | null;
  htmlUrl: string;
  prNumber: number | null;
  state: string;
  lastError: string | null;
  failureExcerpt: string | null;
  analysis: Analysis | null;
  createdAt: string;
}

function confidenceLabel(analysis: Analysis): string {
  if (analysis.inconclusive) return "Not enough evidence to be sure";
  if (analysis.confidence >= 0.8) return "High confidence";
  if (analysis.confidence >= 0.6) return "Probable";
  return "Best guess";
}

export default function CiFailurePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useQuery<{ failure: Failure }>(`/api/ci/${id}`, [id]);

  if (detail.error) {
    return (
      <div className="banner banner--warn" role="status">
        That CI failure does not exist, or it belongs to another organisation.
      </div>
    );
  }

  if (!detail.data) return <p className="dim">Loading…</p>;

  const failure = detail.data.failure;
  const analysis = failure.analysis;
  const where = [failure.jobName, failure.stepName].filter(Boolean).join(" / ");

  return (
    <>
      <PageHead
        title={`${failure.workflowName} failed`}
        sub={
          <>
            {failure.owner}/{failure.repo} · {failure.branch} ·{" "}
            <code>{failure.headSha.slice(0, 8)}</code>
            {failure.prNumber ? ` · merged #${failure.prNumber}` : ""} ·{" "}
            {new Date(failure.createdAt).toLocaleString()}
          </>
        }
      />

      {/* The state is shown rather than hidden when there is no analysis. A
          failure Sadhak could not explain is still a failure worth seeing, and
          saying so is better than an empty page that looks like a bug. */}
      {!analysis && (
        <div className="banner banner--warn" role="status">
          {failure.state === "failed"
            ? `This failure could not be analysed: ${failure.lastError ?? "unknown reason"}`
            : "This failure has not been analysed yet."}
        </div>
      )}

      {analysis && (
        <section className="panel">
          <div className="ci__verdict">
            <span className="tag">{confidenceLabel(analysis)}</span>
            {analysis.quickFix && (
              <span className="tag tag--amber">{analysis.quickLabel ?? "Quick fix"}</span>
            )}
          </div>

          <h2 className="ci__heading">What to do</h2>
          <p className="ci__recommendation">{analysis.recommendation}</p>

          <h2 className="ci__heading">Why</h2>
          <p className="ci__cause">{analysis.cause}</p>

          {analysis.evidence.length > 0 && (
            <>
              <h2 className="ci__heading">Evidence</h2>
              <ul className="ci__evidence">
                {analysis.evidence.map((item) => (
                  <li key={`${item.source}:${item.detail}`} className="ci__evidence-item">
                    <span className="ci__evidence-source">{item.source}</span>
                    <span>{item.detail}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {analysis?.precedent && analysis.precedent.length > 0 && (
        <section className="panel">
          <h2 className="ci__heading">This has happened before</h2>
          <ul className="ci__precedent">
            {analysis.precedent.map((prior) => (
              <li key={prior.id} className="ci__precedent-item">
                <a href={prior.htmlUrl} rel="noreferrer noopener" target="_blank">
                  {new Date(prior.createdAt).toLocaleDateString()} ·{" "}
                  <code>{prior.headSha.slice(0, 8)}</code>
                  {prior.jobName ? ` · ${prior.jobName}` : ""}
                </a>
                {prior.recommendation && (
                  <p className="ci__precedent-fix">Resolved by: {prior.recommendation}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis?.paths && analysis.paths.length > 0 && (
        <section className="panel">
          <h2 className="ci__heading">What this merge changed</h2>
          <ul className="ci__paths">
            {analysis.paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <div className="ci__log-head">
          <h2 className="ci__heading">The failing log{where ? ` — ${where}` : ""}</h2>
          <a
            className="btn btn--ghost"
            href={failure.htmlUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            Open the run
          </a>
        </div>
        {failure.failureExcerpt ? (
          <pre className="ci__log">{failure.failureExcerpt}</pre>
        ) : (
          <p className="dim">
            GitHub did not return the logs for this run. Actions retention expires, so a
            run analysed long after the fact keeps its metadata and loses its output.
          </p>
        )}
      </section>
    </>
  );
}
