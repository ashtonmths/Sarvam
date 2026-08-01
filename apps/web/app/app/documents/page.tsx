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

  async function readFile(file: File) {
    setOriginalName(file.name);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
    setText(await file.text());
  }

  async function upload() {
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
        // datetime-local has no zone, so it is read as the browser's. That is
        // the right reading here: the person typing it means their own clock.
        ...(occurredAt ? { occurredAt: new Date(occurredAt).toISOString() } : {}),
      });
      setMessage(`${result.chunkCount} chunks. ${result.note}`);
      setTitle("");
      setText("");
      setOriginalName(undefined);
      setOccurredAt("");
      documents.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this document? Rationale already quoted from it is kept."))
      return;
    try {
      await api.delete(`/api/documents/${id}`);
      documents.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed");
    }
  }

  const items = documents.data?.items ?? [];

  return (
    <>
      <PageHead
        title="Documents"
        sub="Meeting transcripts and notes. The Historian searches these alongside Slack and pull requests, and cites them the same way."
      />

      <section className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Upload</h2>

        <label className="field">
          <span>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Billing migration sync, 12 March"
          />
        </label>

        <label className="field">
          <span>When it happened</span>
          <input
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </label>

        <label className="field">
          <span>File</span>
          <input
            type="file"
            accept={ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
        </label>

        <label className="field">
          <span>Or paste the transcript</span>
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "Priya Raman: We dropped vat_rate because the EU report computes it now."
            }
          />
        </label>

        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !title.trim() || !text.trim()}
          onClick={() => void upload()}
        >
          {busy ? "Uploading…" : "Upload"}
        </button>

        {message && (
          <p className="dim" style={{ marginTop: 10, fontSize: 13.5 }}>
            {message}
          </p>
        )}
        {error && (
          <div className="banner banner--warn" role="status" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </section>

      {items.length === 0 ? (
        <EmptyState
          title="No documents yet"
          body="Upload a meeting transcript and the Historian can cite what was said in it, the same way it cites a Slack thread."
        />
      ) : (
        <div className="card">
          {items.map((doc) => (
            <div key={doc.id} className="conn-row">
              <div className="conn-row__meta">
                <strong>
                  <a href={`/app/documents/${doc.id}`}>{doc.title}</a>
                </strong>
                <span>
                  {doc.chunks} chunks
                  {doc.pending > 0 ? ` · ${doc.pending} still embedding` : ""}
                  {` · ${Math.max(1, Math.round(doc.byteSize / 1024))}KB`}
                  {doc.uploadedBy ? ` · ${doc.uploadedBy}` : ""}
                </span>
              </div>
              {doc.pending > 0 && <span className="tag tag--amber">embedding</span>}
              <button type="button" className="btn" onClick={() => void remove(doc.id)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
