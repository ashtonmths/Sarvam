"use client";

import { useState } from "react";
import { EmptyState, PageHead } from "../../../components/app/ui";
import { api } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * Checkpoint-bounded incident investigation.
 *
 * The page is built around the idea rather than around the data: the point is
 * that the search started small and widened only as far as it had to, so the
 * rounds are shown even when the first one answered — that progression *is*
 * the result.
 */

interface Candidate {
  kind: string;
  externalId: string;
  title: string;
  url: string;
  author: string | null;
  occurredAt: string;
  score: number;
  why: string[];
  paths: string[];
}

interface Round {
  reason: string;
  from: string;
  to: string;
  totalInWindow: number;
  confidence: number;
  top: Candidate[];
}

interface Result {
  // The API returns a full checkpoint row; these are the fields read here.
  checkpoint: CheckpointRow | null;
  window: { from: string; to: string } | null;
  windowsSearched: number;
  likelyCause: Candidate | null;
  supporting: Candidate[];
  confidence: number;
  recommendation: string;
  caveat: string | null;
  stoppedBecause: string;
  rounds: Round[];
}

interface RepoRow {
  id: number;
  fullName: string;
  changes: number;
  earliest: string | null;
  latest: string | null;
  backfillComplete: boolean;
}

interface CheckpointRow {
  id: number;
  kind: string;
  label: string;
  confidence: number;
  occurredAt: string;
}

const HOURS = (iso: string) => new Date(iso).toLocaleString();

export default function InvestigatePage() {
  const repos = useQuery<{ items: RepoRow[] }>("/api/repos", []);
  const checkpoints = useQuery<{ items: CheckpointRow[] }>("/api/checkpoints", []);

  const [symptom, setSymptom] = useState("");
  const [repoFullName, setRepoFullName] = useState("");
  const [incidentAt, setIncidentAt] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [repoInput, setRepoInput] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repoNote, setRepoNote] = useState<string | null>(null);

  async function track(event: React.FormEvent) {
    event.preventDefault();
    setRepoBusy(true);
    setRepoError(null);
    setRepoNote(null);
    try {
      const added = await api.post<{ fullName: string; note: string }>("/api/repos", {
        fullName: repoInput.trim(),
      });
      setRepoNote(`${added.fullName}: ${added.note}`);
      setRepoInput("");
      repos.reload();
    } catch (caught) {
      setRepoError(caught instanceof Error ? caught.message : "Could not track it");
    } finally {
      setRepoBusy(false);
    }
  }

  const [cpLabel, setCpLabel] = useState("");
  const [cpBusy, setCpBusy] = useState(false);
  const [cpError, setCpError] = useState<string | null>(null);

  async function mark(event: React.FormEvent) {
    event.preventDefault();
    setCpBusy(true);
    setCpError(null);
    try {
      await api.post("/api/checkpoints", { label: cpLabel, kind: "manual" });
      setCpLabel("");
      checkpoints.reload();
    } catch (caught) {
      setCpError(caught instanceof Error ? caught.message : "Could not record it");
    } finally {
      setCpBusy(false);
    }
  }

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.post<Result>("/api/investigate", {
          symptom,
          ...(repoFullName ? { repoFullName } : {}),
          ...(incidentAt ? { incidentAt: new Date(incidentAt).toISOString() } : {}),
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Investigation failed");
    } finally {
      setBusy(false);
    }
  }

  const repoItems = repos.data?.items ?? [];
  const totalChanges = repoItems.reduce((sum, r) => sum + r.changes, 0);

  return (
    <>
      <PageHead
        title="Investigate"
        sub="Starts at the last moment things were known good and searches forward to the incident. It widens to an earlier checkpoint only when that window comes up empty."
      />

      <section className="panel" style={{ marginBottom: 18 }}>
        <h2 className="panel__title">What broke?</h2>
        <p className="panel__caption">
          Name the thing that failed — a table, a field, a service, or the error text.
        </p>

        <form className="docup" onSubmit={run}>
          <div className="field">
            <label htmlFor="symptom">Symptom</label>
            <input
              id="symptom"
              value={symptom}
              required
              onChange={(e) => setSymptom(e.target.value)}
              placeholder="eu_vat_report is empty since this morning"
            />
          </div>

          <div className="field">
            <label htmlFor="repo">Repository</label>
            <select
              id="repo"
              value={repoFullName}
              onChange={(e) => setRepoFullName(e.target.value)}
            >
              <option value="">Every tracked repository</option>
              {repoItems.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="incident-at">When it broke</label>
            <input
              id="incident-at"
              type="datetime-local"
              value={incidentAt}
              onChange={(e) => setIncidentAt(e.target.value)}
            />
            <p className="field__help">Leave empty to investigate as of now.</p>
          </div>

          <div className="docup__actions">
            <button
              type="submit"
              className="btn btn--ink btn--small"
              disabled={busy || !symptom.trim()}
            >
              {busy ? "Searching…" : "Investigate"}
            </button>
            <span className="docup__note">
              {totalChanges} changes across {repoItems.length} repositories
            </span>
          </div>

          {error && (
            <div className="banner banner--warn" role="status">
              {error}
            </div>
          )}
        </form>
      </section>

      {result && <Report result={result} />}

      <section className="panel" style={{ marginTop: 18 }}>
        <h2 className="panel__title">Repositories</h2>
        <p className="panel__caption">
          Sadhak walks each one's history backwards and keeps it current. Nothing can be
          investigated until at least one is tracked.
        </p>

        <form className="docup" onSubmit={track} style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="repo-full-name">Track a repository</label>
            <input
              id="repo-full-name"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="acme/billing"
            />
            <p className="field__help">
              As it appears in the GitHub URL. It must be covered by this organisation's
              Sadhak app installation.
            </p>
          </div>
          <div className="docup__actions">
            <button
              type="submit"
              className="btn btn--ghost btn--small"
              disabled={repoBusy || !repoInput.trim()}
            >
              {repoBusy ? "Tracking…" : "Track"}
            </button>
            {repoNote && <span className="docup__note">{repoNote}</span>}
          </div>
          {repoError && (
            <div className="banner banner--warn" role="status">
              {repoError}
            </div>
          )}
        </form>

        {repoItems.length === 0 ? (
          <EmptyState
            title="No repositories tracked"
            body="Track one above, or install the Sadhak GitHub app on it and push — a push registers the repository automatically."
          />
        ) : (
          <div className="doclist">
            {repoItems.map((repo) => (
              <div key={repo.id} className="docrow">
                <div className="docrow__body">
                  <span className="docrow__name">{repo.fullName}</span>
                  <span className="docrow__meta">
                    {repo.changes} changes
                    {repo.earliest ? ` · back to ${HOURS(repo.earliest)}` : ""}
                  </span>
                </div>
                {/* Stated, not implied: a half-walked repo must not look like
                    one whose history simply starts where it does. */}
                <span
                  className={repo.backfillComplete ? "tag tag--green" : "tag tag--amber"}
                >
                  {repo.backfillComplete ? "complete" : "walking history"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <h2 className="panel__title">Checkpoints</h2>
        <p className="panel__caption">
          Known-good moments. The most recent one before an incident is where a search
          starts, so recording them makes every later investigation narrower.
        </p>

        {/* The empty state used to tell people to mark one by hand while no
            surface offered it. This is that surface. */}
        <form className="docup" onSubmit={mark} style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="cp-label">Mark now as known-good</label>
            <input
              id="cp-label"
              value={cpLabel}
              onChange={(e) => setCpLabel(e.target.value)}
              placeholder="Released 2.4.1, checked the dashboard"
            />
            <p className="field__help">
              Recorded at the current time, with the highest confidence of any checkpoint
              kind, because a person checked.
            </p>
          </div>
          <div className="docup__actions">
            <button
              type="submit"
              className="btn btn--ghost btn--small"
              disabled={cpBusy || !cpLabel.trim()}
            >
              {cpBusy ? "Recording…" : "Record checkpoint"}
            </button>
            {cpError && <span className="docup__note">{cpError}</span>}
          </div>
        </form>

        {(checkpoints.data?.items ?? []).length === 0 ? (
          <EmptyState
            title="No checkpoints yet"
            body="A clean crawl records one automatically. Mark one above after a release and the next investigation starts from there instead of guessing."
          />
        ) : (
          <div className="doclist">
            {(checkpoints.data?.items ?? []).map((cp) => (
              <div key={cp.id} className="docrow">
                <div className="docrow__body">
                  <span className="docrow__name">{cp.label}</span>
                  <span className="docrow__meta">
                    {cp.kind.replace(/_/g, " ")} · confidence {cp.confidence.toFixed(2)} ·{" "}
                    {HOURS(cp.occurredAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function Report({ result }: { result: Result }) {
  return (
    <section className="panel">
      <h2 className="panel__title">
        {result.likelyCause ? "Likely cause" : "No confident cause"}
      </h2>
      <p className="panel__caption">
        Searched {result.windowsSearched}{" "}
        {result.windowsSearched === 1 ? "window" : "windows"}
        {result.checkpoint
          ? ` starting from ${result.checkpoint.kind.replace(/_/g, " ")}: ${result.checkpoint.label}`
          : " with no checkpoint to start from"}
        .
      </p>

      {result.likelyCause ? (
        <div className="docchunk" data-focused="true" style={{ marginBottom: 12 }}>
          <div className="docchunk__head">
            <span className="docchunk__ordinal">
              {result.likelyCause.kind === "commit" ? "commit" : "PR"}{" "}
              {result.likelyCause.externalId.slice(0, 12)}
            </span>
            {result.likelyCause.author && (
              <span className="docchunk__speaker">{result.likelyCause.author}</span>
            )}
            <span className="tag tag--amber">
              score {result.likelyCause.score.toFixed(2)}
            </span>
          </div>
          <p className="docchunk__body">
            <a href={result.likelyCause.url} rel="noreferrer noopener" target="_blank">
              {result.likelyCause.title}
            </a>
          </p>
          <p className="docrow__meta" style={{ marginTop: 6 }}>
            {result.likelyCause.why.join(" · ")}
          </p>
        </div>
      ) : (
        <EmptyState title="Nothing stood out" body={result.recommendation} />
      )}

      {result.likelyCause && (
        <div className="banner" role="status" style={{ marginBottom: 12 }}>
          {result.recommendation}
        </div>
      )}

      {/* Stated, never implied: a bounded search that found nothing is a
          different answer from one that ran out of room to look. */}
      {result.caveat && (
        <div className="banner banner--warn" role="status" style={{ marginBottom: 12 }}>
          {result.caveat}
        </div>
      )}

      <h3 className="panel__title" style={{ fontSize: 15, marginTop: 16 }}>
        How the search widened
      </h3>
      <div className="doclist">
        {result.rounds.map((round, index) => (
          <div key={`${round.from}-${index}`} className="docrow">
            <div className="docrow__body">
              <span className="docrow__name">
                Round {index + 1}: {round.reason}
              </span>
              <span className="docrow__meta">
                {HOURS(round.from)} → {HOURS(round.to)} · {round.totalInWindow} changes ·
                best {round.confidence.toFixed(2)}
              </span>
            </div>
            {round.confidence >= 0.6 && <span className="tag tag--green">answered</span>}
          </div>
        ))}
      </div>

      {result.supporting.length > 0 && (
        <>
          <h3 className="panel__title" style={{ fontSize: 15, marginTop: 16 }}>
            Also in the window
          </h3>
          <div className="doclist">
            {result.supporting.map((candidate) => (
              <div key={candidate.externalId} className="docrow">
                <div className="docrow__body">
                  <a
                    className="docrow__name"
                    href={candidate.url}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {candidate.title}
                  </a>
                  <span className="docrow__meta">
                    {candidate.score.toFixed(2)} · {candidate.why.join(" · ")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
