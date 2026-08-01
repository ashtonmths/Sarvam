"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Kbd, PageHead } from "../../../components/app/ui";
import { ApiError, api, type Coverage, type RationaleRow } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * Where coverage becomes real. Built for operators: keyboard-first,
 * source-first, with a 15-second undo window before anything is written.
 *
 * The undo buffer is not a nicety — it protects the one number that must never
 * lie from the review tool that moves it. A fast reviewer mis-keying `a` does
 * not get to pollute `confirmed`.
 *
 * There is deliberately no drift-corrections tab: Reviewer (plan 11) does not
 * exist yet, and a tab backed by nothing reads as a broken feature.
 */

const UNDO_MS = 15_000;

interface Pending {
  kind: "confirm" | "reject";
  id: number;
  label: string;
}

const initials = (name: string | null) =>
  (name ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function QueuePage() {
  const drafts = useQuery<{ items: RationaleRow[] }>("/api/rationale?state=drafted");
  const coverage = useQuery<Coverage>("/api/metrics/coverage");

  const [cursor, setCursor] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [help, setHelp] = useState(false);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = drafts.data?.items ?? [];
  const active = Math.min(cursor, Math.max(0, items.length - 1));

  /** The mutation fires only when the window closes — until then, nothing. */
  const commit = useCallback(
    async (p: Pending) => {
      try {
        await api.post(
          `/api/rationale/${p.id}/${p.kind}`,
          p.kind === "reject" ? { reason } : {},
        );
        drafts.reload();
        coverage.reload();
      } catch (err) {
        setError(err instanceof ApiError ? err.userMessage : "Could not save");
      }
      setPending(null);
    },
    [drafts, coverage, reason],
  );

  const act = useCallback(
    (kind: Pending["kind"], id: number, label: string) => {
      if (pending && timer.current) {
        clearTimeout(timer.current);
        void commit(pending);
      }
      const next: Pending = { kind, id, label };
      setPending(next);
      timer.current = setTimeout(() => void commit(next), UNDO_MS);
    },
    [pending, commit],
  );

  const undo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPending(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;

      if (rejecting !== null) {
        if (e.key === "Escape") setRejecting(null);
        return;
      }

      const draft = items[active];
      switch (e.key) {
        case "j":
          setCursor((c) => Math.min(c + 1, items.length - 1));
          break;
        case "k":
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "o":
          if (draft) window.open(draft.sourceUrl, "_blank", "noreferrer");
          break;
        case "a":
          if (draft) act("confirm", draft.id, `Confirmed draft #${draft.id}`);
          break;
        case "x":
          if (draft) {
            setRejecting(draft.id);
            setReason("");
          }
          break;
        case "u":
          undo();
          break;
        case "?":
          setHelp((h) => !h);
          break;
        case "Escape":
          setHelp(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, active, act, undo, rejecting]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const cov = coverage.data;
  const pct =
    cov && cov.totalEdges > 0
      ? Math.round((cov.coverageConfirmed / cov.totalEdges) * 100)
      : 0;

  return (
    <>
      <PageHead
        title="Queue"
        sub={
          <>
            <strong>{pct}% of edges have confirmed rationale</strong> · {items.length}{" "}
            drafts pending review — drafts do not count toward coverage.
          </>
        }
      >
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => setHelp(true)}
        >
          Keyboard <Kbd>?</Kbd>
        </button>
      </PageHead>

      {error && (
        <div className="banner banner--warn" role="alert">
          {error}
        </div>
      )}

      <div ref={listRef}>
        {drafts.loading ? (
          <div className="panel" style={{ height: 160, opacity: 0.4 }} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No drafts waiting"
            body="Historian queues drafts here as it explains edges. Every edge it cannot explain from written evidence stays honestly unexplained rather than guessed at."
            action={{ href: "/app/agents", label: "See what the agents found →" }}
          />
        ) : (
          items.map((r, i) => (
            <article
              key={r.id}
              className="queue__row"
              data-active={i === active}
              data-idx={i}
              onClick={() => setCursor(i)}
              data-testid={`queue-draft-${r.id}`}
            >
              <div>
                <div className="queue__head">
                  <span className="queue__avatar" aria-hidden="true">
                    {initials(r.author)}
                  </span>
                  <span className="queue__who">
                    <strong>{r.author ?? "unknown"}</strong>
                    <span>
                      mined from {r.sourceKind} · {timeAgo(r.createdAt)}
                    </span>
                  </span>
                  {r.confidence !== null && (
                    <span className="queue__conf" title="Historian's confidence">
                      <i>
                        <b style={{ width: `${r.confidence * 100}%` }} />
                      </i>
                      {r.confidence.toFixed(2)}
                    </span>
                  )}
                </div>
                <blockquote className="queue__quote">&ldquo;{r.body}&rdquo;</blockquote>
                <div className="queue__meta">
                  {r.srcName && r.dstName && (
                    <span className="tag tag--thread">
                      {r.srcName} → {r.dstName}
                    </span>
                  )}
                  <Link
                    href="/app/graph"
                    className="dim"
                    style={{ textDecoration: "underline" }}
                  >
                    view edge
                  </Link>
                </div>
              </div>
              <div className="queue__actions">
                {/* Verification is one click, always — the source is the
                    primary action, not a footnote. */}
                <a
                  className="queue__source"
                  href={r.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="queue-draft-source"
                >
                  Verify source ↗
                </a>
                <button
                  type="button"
                  className="btn btn--approve btn--tiny"
                  onClick={() => act("confirm", r.id, `Confirmed draft #${r.id}`)}
                  data-testid="queue-draft-confirm"
                >
                  Confirm <Kbd>a</Kbd>
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost btn--tiny"
                  onClick={() => {
                    setRejecting(r.id);
                    setReason("");
                  }}
                  data-testid="queue-draft-reject"
                >
                  Reject <Kbd>x</Kbd>
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      {pending && (
        <div className="undo-toast" role="status" data-testid="queue-undo-toast">
          {pending.label} — nothing written yet
          <button type="button" onClick={undo}>
            Undo <Kbd>u</Kbd>
          </button>
        </div>
      )}

      {rejecting !== null && (
        <div
          className="help-overlay"
          role="dialog"
          aria-label="Reject with reason"
          onClick={() => setRejecting(null)}
        >
          <div className="help-overlay__card" onClick={(e) => e.stopPropagation()}>
            <h2>Reject</h2>
            <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
              Rejected drafts are kept, not deleted — the acceptance rate is how we tell
              whether the agent is worth trusting.
            </p>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this wrong?"
              aria-label="Rejection reason"
              style={{
                width: "100%",
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: "9px 12px",
                font: "inherit",
                fontSize: 14,
              }}
              data-testid="reject-reason"
            />
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                type="button"
                className="btn btn--danger-ghost btn--tiny"
                onClick={() => {
                  const id = rejecting;
                  setRejecting(null);
                  act("reject", id, `Rejected draft #${id}`);
                }}
                data-testid="reject-submit"
              >
                Reject
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--tiny"
                onClick={() => setRejecting(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {help && (
        <div
          className="help-overlay"
          role="dialog"
          aria-label="Keyboard shortcuts"
          onClick={() => setHelp(false)}
        >
          <div className="help-overlay__card" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard</h2>
            <dl>
              <dt>
                <Kbd>j</Kbd> / <Kbd>k</Kbd>
              </dt>
              <dd>next / previous draft</dd>
              <dt>
                <Kbd>o</Kbd>
              </dt>
              <dd>open the cited source in a new tab</dd>
              <dt>
                <Kbd>a</Kbd>
              </dt>
              <dd>confirm — this is what moves coverage</dd>
              <dt>
                <Kbd>x</Kbd>
              </dt>
              <dd>reject, with a reason</dd>
              <dt>
                <Kbd>u</Kbd>
              </dt>
              <dd>undo (15s window — nothing is written until it closes)</dd>
            </dl>
          </div>
        </div>
      )}
    </>
  );
}
