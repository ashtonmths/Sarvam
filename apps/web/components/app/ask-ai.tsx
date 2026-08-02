"use client";

import { Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";

/**
 * Ask a question in prose and get an answer out of the org's own documents.
 *
 * The citations are not decoration. Everything else in Sadhak is deterministic
 * and checkable, and an answer written by a model is the one place that stops
 * being true — so the sources sit under every answer, numbered to match the
 * `[1]` markers in the prose, each linking to the exact chunk it came from.
 * Read as a claim you can open, it fits the rest of the product. Read as a
 * chatbot, it does not.
 */

interface Source {
  n: number;
  kind: "document" | "slack";
  title: string;
  speaker: string | null;
  permalink: string;
  occurredAt: string | null;
  excerpt: string;
}

interface AskResponse {
  answer: string;
  sources: Source[];
  grounded: boolean;
  unavailable?: string;
  /** Corpora that could not be consulted — said out loud, never implied. */
  notes?: string[];
}

export function AskAi() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on open, so the panel is usable from the keyboard without a second
  // click, and Escape closes it — the two things anyone tries first.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3 || busy) return;

    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<AskResponse>("/api/ask", { question: q }));
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="topnav__ask"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Ask a question about your organisation"
        data-testid="ask-ai-trigger"
      >
        <Sparkles size={15} strokeWidth={2} aria-hidden />
        <span>Ask</span>
      </button>

      {open && (
        <>
          {/* Click-away, not a modal: this answers questions *about* the page
              behind it, and covering that up would be the wrong trade. */}
          <button
            type="button"
            className="ask__scrim"
            aria-label="Close"
            onClick={() => setOpen(false)}
          />
          <section className="ask" aria-label="Ask about your organisation">
            <header className="ask__head">
              <h2 className="ask__title">Ask</h2>
              <button
                type="button"
                className="ask__close"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={15} strokeWidth={2} aria-hidden />
              </button>
            </header>

            <form className="ask__form" onSubmit={ask}>
              <input
                ref={inputRef}
                className="ask__input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Why do we still store invoices.vat_rate?"
                aria-label="Your question"
                maxLength={500}
              />
              <button
                type="submit"
                className="btn btn--ink"
                disabled={busy || question.trim().length < 3}
              >
                {busy ? "Reading…" : "Ask"}
              </button>
            </form>

            <p className="ask__hint">
              Answered from your uploaded documents, with the passages it used.
            </p>

            {error && (
              <div className="banner banner--warn" role="status">
                {error}
              </div>
            )}

            {result && (
              <div className="ask__result">
                {result.unavailable && (
                  <div className="banner banner--warn" role="status">
                    {result.unavailable}
                  </div>
                )}

                {result.answer && <p className="ask__answer">{result.answer}</p>}

                {result.notes?.map((note) => (
                  <p key={note} className="ask__note">
                    {note}
                  </p>
                ))}

                {result.sources.length > 0 && (
                  <>
                    <h3 className="ask__sources-title">Sources</h3>
                    <ol className="ask__sources">
                      {result.sources.map((source) => (
                        <li key={source.permalink} className="ask__source">
                          <a className="ask__source-link" href={source.permalink}>
                            [{source.n}] {source.title}
                            {source.speaker ? ` · ${source.speaker}` : ""}
                          </a>
                          {/* A thread and a minuted decision carry different
                              weight; an undifferentiated list hides that. */}
                          <span
                            className={`tag tag--tiny${source.kind === "slack" ? " tag--thread" : ""}`}
                          >
                            {source.kind}
                          </span>
                          <p className="ask__source-excerpt">{source.excerpt}</p>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
