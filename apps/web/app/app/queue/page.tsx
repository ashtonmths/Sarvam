"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Kbd, PageHead } from "../../../components/app/ui";
import {
  CORRECTIONS,
  EDGES,
  METRICS,
  nodeById,
  RATIONALE,
  timeAgo,
} from "../../../lib/mock/data";
import { useHasGraph } from "../../../lib/queries";
import { useSession } from "../../../lib/session";

type Tab = "drafts" | "corrections";
type Pending = {
  kind: "confirm" | "reject" | "apply";
  tab: Tab;
  id: number;
  label: string;
};

const UNDO_MS = 15000;

/** Whitespace-normalized containment — the §10.2 rule the recite re-check runs. */
const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export default function QueuePage() {
  const { org } = useSession();
  const { hasGraph } = useHasGraph(org?.id ?? null);
  const [tab, setTab] = useState<Tab>("drafts");
  const [cursor, setCursor] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmedDelta, setConfirmedDelta] = useState(0);
  const [help, setHelp] = useState(false);
  const [recite, setRecite] = useState<number | null>(null);
  const [reciteText, setReciteText] = useState("");
  const [reciteError, setReciteError] = useState(false);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const drafts = RATIONALE.filter(
    (r) => r.state === "drafted" && !done.has(`drafts-${r.id}`),
  );
  const corrections = CORRECTIONS.filter((c) => !done.has(`corrections-${c.id}`));
  const items = tab === "drafts" ? drafts.length : corrections.length;
  const active = Math.min(cursor, Math.max(0, items - 1));

  /**
   * Undo buffer: the "mutation" only lands when the 15s window closes. A
   * mis-keyed `a` never pollutes confirmed — the coverage metric is protected
   * from its own review tool.
   */
  const commit = useCallback((p: Pending) => {
    setDone((prev) => new Set(prev).add(`${p.tab}-${p.id}`));
    if (p.kind === "confirm") setConfirmedDelta((d) => d + 1);
    setPending(null);
  }, []);

  const act = useCallback(
    (kind: Pending["kind"], id: number, label: string) => {
      // A queued action flushes immediately if a new one starts.
      if (pending && undoTimer.current) {
        clearTimeout(undoTimer.current);
        commit(pending);
      }
      const p: Pending = { kind, tab, id, label };
      setPending(p);
      undoTimer.current = setTimeout(() => commit(p), UNDO_MS);
    },
    [pending, tab, commit],
  );

  const undo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setPending(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;

      // A layered dialog owns the keyboard; only Escape passes through.
      if (recite != null || rejecting != null) {
        if (e.key === "Escape") {
          setRecite(null);
          setRejecting(null);
          setReciteError(false);
        }
        return;
      }

      const draft = drafts[active];
      const corr = corrections[active];

      switch (e.key) {
        case "j":
          setCursor((c) => Math.min(c + 1, items - 1));
          break;
        case "k":
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "o":
          if (tab === "drafts" && draft)
            window.open(draft.sourceUrl, "_blank", "noreferrer");
          break;
        case "a":
          if (tab === "drafts" && draft)
            act("confirm", draft.id, `Confirmed draft #${draft.id}`);
          if (tab === "corrections" && corr)
            act("apply", corr.id, `Applied correction: ${corr.summary}`);
          break;
        case "e":
          if (tab === "drafts" && draft) {
            setRecite(draft.id);
            setReciteText(draft.body);
            setReciteError(false);
          }
          break;
        case "x":
          if (tab === "drafts" && draft) setRejecting(draft.id);
          if (tab === "corrections" && corr) setRejecting(corr.id);
          setRejectReason("");
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
  }, [active, items, tab, drafts, corrections, act, undo, recite, rejecting]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!hasGraph) {
    return (
      <>
        <PageHead
          title="Queue"
          sub="Rationale drafts and drift corrections wait here for human review."
        />
        <EmptyState
          title="Nothing to review yet"
          body="Connect a system first — Historian and Reviewer queue their work here once a graph exists."
          action={{ href: "/app/onboarding", label: "Start onboarding →" }}
        />
      </>
    );
  }

  const confirmedNow = METRICS.confirmedCount + confirmedDelta;
  const coveragePct = Math.round((confirmedNow / METRICS.edgeCount) * 100);
  const reciteDraft = recite != null ? drafts.find((d) => d.id === recite) : null;

  return (
    <>
      <PageHead
        title="Queue"
        sub={
          <>
            <strong>{coveragePct}% of edges have confirmed rationale</strong> ·{" "}
            {drafts.length} drafts pending review — drafts do not count toward coverage.
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

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "drafts"}
          onClick={() => {
            setTab("drafts");
            setCursor(0);
          }}
          data-testid="queue-tab-drafts"
        >
          Rationale drafts ({drafts.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "corrections"}
          onClick={() => {
            setTab("corrections");
            setCursor(0);
          }}
          data-testid="queue-tab-corrections"
        >
          Drift corrections ({corrections.length})
        </button>
      </div>

      <div ref={listRef}>
        {tab === "drafts" &&
          (drafts.length === 0 ? (
            <EmptyState
              title="No drafts waiting"
              body={
                <>
                  Historian queues drafts here as it explains edges —{" "}
                  {METRICS.unexplainedCount} edges remain unexplained.
                </>
              }
              action={{
                href: "/app/graph?filter=unexplained",
                label: "Browse unexplained edges →",
              }}
            />
          ) : (
            drafts.map((r, i) => {
              const edge = EDGES.find((e) => e.id === r.edgeId)!;
              return (
                <article
                  key={r.id}
                  className="queue__row"
                  data-active={i === active}
                  data-idx={i}
                  onClick={() => setCursor(i)}
                  data-testid={`queue-draft-${r.id}`}
                >
                  <div>
                    <blockquote className="queue__quote">
                      &ldquo;{r.body}&rdquo;
                    </blockquote>
                    <div className="queue__meta">
                      <span className="tag tag--thread">
                        {nodeById(edge.source).name} → {nodeById(edge.target).name}
                      </span>
                      <span>
                        {r.author} · {r.sourceKind}
                      </span>
                      <span className="mono">confidence {r.confidence?.toFixed(2)}</span>
                      <span className="dim">{timeAgo(r.createdAt)}</span>
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
                      className="btn btn--ghost btn--tiny"
                      onClick={() => {
                        setRecite(r.id);
                        setReciteText(r.body);
                        setReciteError(false);
                      }}
                      data-testid="queue-draft-recite"
                    >
                      Edit &amp; recite <Kbd>e</Kbd>
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger-ghost btn--tiny"
                      onClick={() => {
                        setRejecting(r.id);
                        setRejectReason("");
                      }}
                      data-testid="queue-draft-reject"
                    >
                      Reject <Kbd>x</Kbd>
                    </button>
                  </div>
                </article>
              );
            })
          ))}

        {tab === "corrections" &&
          (corrections.length === 0 ? (
            <EmptyState
              title="No drift waiting"
              body="Reviewer wakes only when a subgraph's hash changes. When it finds documented state disagreeing with live state, the correction lands here."
            />
          ) : (
            corrections.map((c, i) => (
              <article
                key={c.id}
                className="queue__row"
                data-active={i === active}
                data-idx={i}
                onClick={() => setCursor(i)}
                data-testid={`queue-correction-${c.id}`}
              >
                <div>
                  <strong style={{ fontSize: 15 }}>{c.summary}</strong>
                  <div
                    style={{ display: "grid", gap: 6, margin: "10px 0", fontSize: 13.5 }}
                  >
                    <div>
                      <span className="tag tag--ghost">documented</span>{" "}
                      <span className="dim">{c.documented}</span>
                    </div>
                    <div>
                      <span className="tag tag--amber">live</span> {c.live}
                    </div>
                  </div>
                  <div className="queue__meta">
                    <span className="tag tag--thread">{nodeById(c.nodeId).name}</span>
                    <Link
                      href={`/app/agents/${c.agentRunId}`}
                      className="dim"
                      style={{ textDecoration: "underline" }}
                    >
                      Reviewer&rsquo;s trace
                    </Link>
                    <span className="dim">{timeAgo(c.createdAt)}</span>
                  </div>
                </div>
                <div className="queue__actions">
                  <button
                    type="button"
                    className="btn btn--approve btn--tiny"
                    onClick={() => act("apply", c.id, `Applied: ${c.summary}`)}
                    data-testid="queue-correction-apply"
                  >
                    Apply <Kbd>a</Kbd>
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger-ghost btn--tiny"
                    onClick={() => {
                      setRejecting(c.id);
                      setRejectReason("");
                    }}
                    data-testid="queue-correction-reject"
                  >
                    Reject <Kbd>x</Kbd>
                  </button>
                </div>
              </article>
            ))
          ))}
      </div>

      {pending && (
        <div className="undo-toast" role="status" data-testid="queue-undo-toast">
          {pending.label} — nothing written yet
          <button type="button" onClick={undo}>
            Undo <Kbd>u</Kbd>
          </button>
        </div>
      )}

      {reciteDraft && (
        <div
          className="help-overlay"
          role="dialog"
          aria-label="Edit and recite"
          onClick={() => setRecite(null)}
        >
          <div
            className="help-overlay__card"
            style={{ maxWidth: 540 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Edit &amp; recite</h2>
            <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
              The one place a span may change — and never on your word alone. The
              corrected text is re-checked against the live cited source before anything
              is written. The pointer itself is immutable: a wrong{" "}
              <code className="mono">source_url</code> means Reject, then re-cite.
            </p>
            <textarea
              value={reciteText}
              onChange={(e) => {
                setReciteText(e.target.value);
                setReciteError(false);
              }}
              rows={4}
              aria-label="Corrected span"
              style={{
                width: "100%",
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: "10px 12px",
                font: "inherit",
                fontSize: 14,
                resize: "vertical",
              }}
              data-testid="recite-textarea"
            />
            {reciteError && (
              <p
                role="alert"
                style={{ fontSize: 13, color: "var(--block)", marginTop: 8 }}
              >
                422 — this text does not appear in the cited source. Your remaining moves
                are Reject, or re-cite with a pointer to where it does. There is no path
                from a failed recite to a confirmed row.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn--approve btn--tiny"
                onClick={() => {
                  // Mock of the server's §10.2 re-validation: the cited source
                  // "contains" exactly the mined span, so any added words 422.
                  if (
                    normalize(reciteDraft.body).includes(normalize(reciteText)) &&
                    reciteText.trim()
                  ) {
                    setRecite(null);
                    act(
                      "confirm",
                      reciteDraft.id,
                      `Recited & confirmed draft #${reciteDraft.id}`,
                    );
                  } else {
                    setReciteError(true);
                  }
                }}
                data-testid="recite-submit"
              >
                Re-validate &amp; confirm
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--tiny"
                onClick={() => setRecite(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {rejecting != null && (
        <div
          className="help-overlay"
          role="dialog"
          aria-label="Reject with reason"
          onClick={() => setRejecting(null)}
        >
          <div className="help-overlay__card" onClick={(e) => e.stopPropagation()}>
            <h2>Reject</h2>
            <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
              The reason travels with the rejection — Historian and Reviewer learn from
              it.
            </p>
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Why is this wrong?"
              aria-label="Rejection reason"
              autoFocus
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
                disabled={!rejectReason.trim()}
                onClick={() => {
                  const id = rejecting;
                  setRejecting(null);
                  act(
                    "reject",
                    id,
                    tab === "drafts"
                      ? `Rejected draft #${id}`
                      : `Rejected correction #${id}`,
                  );
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
              <dd>next / previous item</dd>
              <dt>
                <Kbd>o</Kbd>
              </dt>
              <dd>open source in new tab</dd>
              <dt>
                <Kbd>a</Kbd>
              </dt>
              <dd>approve / confirm / apply</dd>
              <dt>
                <Kbd>e</Kbd>
              </dt>
              <dd>
                edit &amp; recite (server re-validates containment; 422 → reject or
                re-cite)
              </dd>
              <dt>
                <Kbd>x</Kbd>
              </dt>
              <dd>reject (reason prompt)</dd>
              <dt>
                <Kbd>u</Kbd>
              </dt>
              <dd>undo (15s window — mutation fires after it closes)</dd>
              <dt>
                <Kbd>?</Kbd>
              </dt>
              <dd>toggle this overlay</dd>
            </dl>
          </div>
        </div>
      )}
    </>
  );
}
