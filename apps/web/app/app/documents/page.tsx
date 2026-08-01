"use client";

import { useState } from "react";
import { EmptyState, PageHead } from "../../../components/app/ui";
import { api } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * Uploaded evidence: transcripts and notes the Historian can search alongside
 * Slack and pull requests.
 */

interface DocumentRow {
  id: number;
  title: string;
  originalName: string | null;
  byteSize: number;
  occurredAt: string | null;
  sourceUrl: string | null;
  uploadedBy: string | null;
  createdAt: string;
  chunks: number;
  pending: number;
}

interface DocumentList {
  items: DocumentRow[];
  maxBytes: number;
}

const ACCEPT = ".txt,.md,.markdown,.vtt,.srt,.text,.log";

export default function DocumentsPage() {
  const documents = useQuery<DocumentList>("/api/documents", []);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [originalName, setOriginalName] = useState<string | undefined>(undefined);
  const [occurredAt, setOccurredAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Errors are kept apart by where the user was looking. A failed delete used
   * to render in the upload form at the top of the page, next to inputs nobody
   * had touched, while the row they clicked showed nothing.
   */
  const [listError, setListError] = useState<string | null>(null);
  /**
   * A file input is uncontrolled, so clearing the state around it leaves the
   * browser still showing the old filename — it reads as "still attached" when
   * nothing is. Changing the key remounts it empty.
   */
  const [fileKey, setFileKey] = useState(0);

  async function readFile(file: File) {
    setOriginalName(file.name);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
    setText(await file.text());
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.post<{
        chunkCount: number;
        duplicate: boolean;
        note: string;
      }>("/api/documents", {
        title,
        text,
        ...(originalName ? { originalName } : {}),
        // datetime-local carries no zone, so it reads as the browser's. That
        // is the right reading: the person typing it means their own clock.
        ...(occurredAt ? { occurredAt: new Date(occurredAt).toISOString() } : {}),
      });
      setMessage(`${result.chunkCount} chunks. ${result.note}`);
      setTitle("");
      setText("");
      setOriginalName(undefined);
      setOccurredAt("");
      setFileKey((k) => k + 1);
      documents.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number, name: string) {
    if (!confirm(`Delete "${name}"? Rationale already quoted from it is kept.`)) return;
    setListError(null);
    try {
      await api.delete(`/api/documents/${id}`);
      documents.reload();
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : "Delete failed");
    }
  }

  const items = documents.data?.items ?? [];
  const maxKb = Math.round((documents.data?.maxBytes ?? 2 * 1024 * 1024) / 1024);

  return (
    <>
      <PageHead
        title="Documents"
        sub="Meeting transcripts and handover notes. The Historian searches these alongside Slack and pull requests, and cites them the same way."
      />

      <section className="panel" style={{ marginBottom: 18 }}>
        <h2 className="panel__title">Upload a document</h2>
        <p className="panel__caption">
          Text and markdown, including subtitle exports. Up to {maxKb}KB.
        </p>

        <form className="docup" onSubmit={submit}>
          <div className="field">
            <label htmlFor="doc-title">Title</label>
            <input
              id="doc-title"
              value={title}
              required
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Billing migration sync"
            />
            <p className="field__help">
              What this was, in the words your team would use.
            </p>
          </div>

          <div className="field">
            <label htmlFor="doc-when">When it happened</label>
            <input
              id="doc-when"
              type="datetime-local"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
            />
            <p className="field__help">
              Optional. The date of the meeting, not of the upload, so a citation is
              ordered against the decision it explains.
            </p>
          </div>

          <div className="field">
            <label htmlFor="doc-file">File</label>
            <input
              id="doc-file"
              key={fileKey}
              type="file"
              accept={ACCEPT}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // A rejected read (moved file, denied permission) must say so
                // rather than leave the form holding whatever it had before.
                if (file) {
                  void readFile(file).catch(() =>
                    setError(`Could not read ${file.name}. Try choosing it again.`),
                  );
                }
              }}
            />
          </div>

          <div className="docup__or">or</div>

          <div className="field">
            <label htmlFor="doc-text">Paste the transcript</label>
            <textarea
              id="doc-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Priya Raman: We dropped vat_rate because the EU report computes it now."
            />
          </div>

          <div className="docup__actions">
            <button
              type="submit"
              className="btn btn--ink btn--small"
              disabled={busy || !title.trim() || !text.trim()}
            >
              {busy ? "Uploading…" : "Upload"}
            </button>
            {message && <span className="docup__note">{message}</span>}
          </div>

          {error && (
            <div className="banner banner--warn" role="status">
              {error}
            </div>
          )}
        </form>
      </section>

      <section className="panel">
        <h2 className="panel__title">Uploaded</h2>
        <p className="panel__caption">
          Each document is split into quotable chunks. Semantic search waits on embedding;
          text search works the moment it lands.
        </p>

        {listError && (
          <div className="banner banner--warn" role="status" style={{ marginBottom: 12 }}>
            {listError}
          </div>
        )}

        {items.length === 0 ? (
          <EmptyState
            title="No documents yet"
            body="Upload a meeting transcript and the Historian can cite what was said in it, the same way it cites a Slack thread."
          />
        ) : (
          <div className="doclist">
            {items.map((doc) => (
              <div key={doc.id} className="docrow">
                <div className="docrow__body">
                  <a className="docrow__name" href={`/app/documents/${doc.id}`}>
                    {doc.title}
                  </a>
                  <span className="docrow__meta">
                    {doc.chunks} chunks · {Math.max(1, Math.round(doc.byteSize / 1024))}KB
                    {doc.uploadedBy ? ` · ${doc.uploadedBy}` : ""}
                  </span>
                </div>
                {doc.pending > 0 && (
                  <span className="tag tag--amber">{doc.pending} embedding</span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => void remove(doc.id, doc.title)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
