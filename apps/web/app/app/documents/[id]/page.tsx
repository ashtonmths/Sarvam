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

/**
 * Rejoins lines a transcript hard-wrapped at some column.
 *
 * Meeting notes and subtitle exports arrive wrapped to 72 or 80 characters,
 * and the chunk body is rendered `pre-wrap` because that is right for a
 * verbatim quote. The two together produce the worst of both: the source's
 * wrap points survive, the browser wraps again at its own width, and every
 * paragraph comes out ragged with orphaned fragments and leading spaces.
 *
 * A line is treated as a continuation when it does not begin a new utterance —
 * no `[12:04]` stamp, no `Name:` prefix, not a list item or heading — and the
 * previous line did not end a sentence. Everything else, including blank lines
 * and speaker turns, is left exactly as written.
 *
 * Only the rendering changes. The stored text is untouched, so offsets, chunk
 * boundaries and quoted spans all still refer to the same characters.
 */
function reflow(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const previous = out[out.length - 1];
    const startsUtterance =
      /^\s*\[?\d{1,2}:\d{2}/.test(line) ||
      /^\s*[A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}:/.test(line) ||
      /^\s*(?:[-*•]|\d+\.)\s/.test(line) ||
      /^[A-Z][A-Z ]{3,}$/.test(line.trim());

    const continues =
      previous !== undefined &&
      previous.trim() !== "" &&
      line.trim() !== "" &&
      !startsUtterance &&
      !/[.!?:]["')\]]?$/.test(previous.trim());

    if (continues) out[out.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
    else out.push(line);
  }

  return out.join("\n");
}

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

      <section className="panel">
        {doc.sourceUrl && (
          <p className="panel__caption">
            Original:{" "}
            <a href={doc.sourceUrl} rel="noreferrer noopener" target="_blank">
              {doc.sourceUrl}
            </a>
          </p>
        )}

        <div className="docpage">
          {chunks.map((chunk) => (
            <section
              key={chunk.ordinal}
              id={`chunk-${chunk.ordinal}`}
              className="docchunk"
              // The citation target is marked, not merely scrolled to.
              data-focused={focused === chunk.ordinal}
            >
              <div className="docchunk__head">
                <a className="docchunk__ordinal" href={`#chunk-${chunk.ordinal}`}>
                  #{chunk.ordinal}
                </a>
                {chunk.speaker && (
                  <span className="docchunk__speaker">{chunk.speaker}</span>
                )}
                {!chunk.embedded && <span className="tag tag--amber">embedding</span>}
              </div>
              <p className="docchunk__body">{reflow(chunk.body)}</p>
            </section>
          ))}
        </div>
      </section>
    </>
  );
}
