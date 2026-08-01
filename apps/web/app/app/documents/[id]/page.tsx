"use client";

import { use, useEffect, useState } from "react";
import { PageHead } from "../../../../components/app/ui";
import { useQuery } from "../../../../lib/queries";

/**
 * What a document citation resolves to.
 *
 * Every rationale mined from an upload points at `#chunk-N` here, so this page
 * is the reason storing the text is worth it: a reviewer confirming a claim
 * gets to read the quoted span in the conversation around it, rather than
 * taking the quote's word for itself.
 */

interface Chunk {
  ordinal: number;
  body: string;
  speaker: string | null;
  startOffset: number;
  endOffset: number;
  embedded: boolean;
}

interface DocumentDetail {
  document: {
    id: number;
    title: string;
    originalName: string | null;
    occurredAt: string | null;
    sourceUrl: string | null;
    uploadedBy: string | null;
    createdAt: string;
    byteSize: number;
  };
  chunks: Chunk[];
}

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useQuery<DocumentDetail>(`/api/documents/${id}`, [id]);
  const [focused, setFocused] = useState<number | null>(null);

  /**
   * The anchor is read from the hash rather than left to the browser, because
   * the chunk has to be highlighted as well as scrolled to — landing on the
   * right paragraph with nothing marked leaves the reader hunting for the span
   * the citation meant.
   */
  const loadedChunks = detail.data?.chunks;
  useEffect(() => {
    // Waits on the chunks specifically: the element to scroll to does not
    // exist until they have rendered, so running before then would set the
    // highlight and scroll nowhere.
    if (!loadedChunks) return;

    const apply = () => {
      const match = /^#chunk-(\d+)$/.exec(window.location.hash);
      if (!match?.[1]) return;
      const ordinal = Number(match[1]);
      setFocused(ordinal);
      document.getElementById(`chunk-${ordinal}`)?.scrollIntoView({ block: "center" });
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [loadedChunks]);

  if (detail.error) {
    return (
      <div className="banner banner--warn" role="status">
        That document does not exist, or it was deleted. Rationale quoted from a deleted
        document keeps its quote, but there is no longer a source to read it in.
      </div>
    );
  }

  if (!detail.data) return <p className="dim">Loading…</p>;

  const { document: doc, chunks } = detail.data;
  const when = doc.occurredAt ?? doc.createdAt;

  return (
    <>
      <PageHead
        title={doc.title}
        sub={
          <>
            {doc.originalName ? `${doc.originalName} · ` : ""}
            {chunks.length} chunks · {new Date(when).toLocaleString()}
            {doc.uploadedBy ? ` · uploaded by ${doc.uploadedBy}` : ""}
          </>
        }
      />

      {doc.sourceUrl && (
        <p className="dim" style={{ fontSize: 13.5, marginBottom: 12 }}>
          Original:{" "}
          <a href={doc.sourceUrl} rel="noreferrer noopener" target="_blank">
            {doc.sourceUrl}
          </a>
        </p>
      )}

      <div className="card">
        {chunks.map((chunk) => (
          <section
            key={chunk.ordinal}
            id={`chunk-${chunk.ordinal}`}
            className="doc-chunk"
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              marginBottom: 8,
              // The citation target is marked, not merely scrolled to.
              background:
                focused === chunk.ordinal ? "var(--accent-soft, #fff6d8)" : "transparent",
              borderLeft:
                focused === chunk.ordinal
                  ? "3px solid var(--accent, #d9a300)"
                  : "3px solid transparent",
            }}
          >
            <div
              className="dim"
              style={{ fontSize: 12, marginBottom: 6, display: "flex", gap: 8 }}
            >
              <a href={`#chunk-${chunk.ordinal}`}>#{chunk.ordinal}</a>
              {chunk.speaker && <span>{chunk.speaker}</span>}
              {!chunk.embedded && <span className="tag tag--amber">embedding</span>}
            </div>
            <p style={{ whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.6 }}>
              {chunk.body}
            </p>
          </section>
        ))}
      </div>
    </>
  );
}
