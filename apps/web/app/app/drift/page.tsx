"use client";

import { useState } from "react";
import { EmptyState, Overlay, PageHead } from "../../../components/app/ui";
import { ApiError, api, type DriftFinding, type DriftSummary } from "../../../lib/api";
import { useQuery } from "../../../lib/queries";

/**
 * The correction queue: where the map is told it is wrong.
 *
 * Two resolutions, and the difference between them is the whole point.
 * Dismissing says the change was benign, and that judgment earns suppression —
 * the same signature stops waking anyone for 30 days. Correcting says the
 * change was real and the map has caught up, which suppresses nothing, because
 * a real change happening again should wake someone again.
 *
 * A reason is required to dismiss. Without one, a dismissal cannot later be
 * told apart from an investigation that gave up, and the suppression rule
 * turns on exactly that distinction.
 */

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** `field/1/db/demo_billing/column/public.invoices.vat_rate` reads badly raw. */
function readableScope(scope: string): { kind: string; name: string } {
  const slash = scope.indexOf("/");
  const kind = slash === -1 ? "entity" : scope.slice(0, slash);
  const rest = slash === -1 ? scope : scope.slice(slash + 1);
  return { kind, name: rest.split("/").pop() ?? rest };
}

function shapeOf(finding: DriftFinding): "added" | "removed" | "changed" {
  if (!finding.documentedState?.hash) return "added";
  if (!finding.liveState?.hash) return "removed";
  return "changed";
}

const SHAPE_COPY: Record<string, { label: string; tone: string; body: string }> = {
  added: {
    label: "appeared",
    tone: "var(--approve)",
    body: "Something exists live that the map has never seen.",
  },
  removed: {
    label: "disappeared",
    tone: "var(--block)",
    body: "The map still records this. It is no longer there.",
  },
  changed: {
    label: "changed",
    tone: "var(--warn)",
    body: "The live structure no longer matches what was recorded.",
  },
};

export default function DriftPage() {
  const findings = useQuery<{ items: DriftFinding[] }>("/api/drift/findings");
  const summary = useQuery<DriftSummary>("/api/drift/summary");

  const [dismissing, setDismissing] = useState<DriftFinding | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const items = findings.data?.items ?? [];
  const stats = summary.data;

  async function resolve(finding: DriftFinding, how: "dismiss" | "correct") {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/api/drift/findings/${finding.id}/${how}`,
        how === "dismiss" ? { reason } : {},
      );
      findings.reload();
      summary.reload();
      setDismissing(null);
      setReason("");
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "Could not save");
    }
    setBusy(false);
  }

  return (
    <>
      <PageHead
        title="Drift"
        sub={
          stats ? (
            <span data-testid="drift-summary">
              <strong>
                {stats.open} finding{stats.open === 1 ? "" : "s"} to review
              </strong>{" "}
              · watching {stats.instancesWatched} instance
              {stats.instancesWatched === 1 ? "" : "s"}
              {stats.lastCheckedAt
                ? ` · last checked ${timeAgo(stats.lastCheckedAt)}`
                : ""}
            </span>
          ) : (
            "What the live systems say, against what the map recorded."
          )
        }
      />

      {error && (
        <div className="banner banner--warn" role="alert">
          {error}
        </div>
      )}

      {stats && (
        <div className="ostats">
          <div className="ostats__cell">
            <strong>{stats.open}</strong>
            <span>Open</span>
            <em>waiting on a human judgment</em>
          </div>
          <div className="ostats__cell">
            <strong>{stats.corrected}</strong>
            <span>Corrected</span>
            <em>the map has caught up</em>
          </div>
          <div className="ostats__cell">
            <strong>{stats.dismissed}</strong>
            <span>Judged benign</span>
            <em>each one earns a 30-day mute</em>
          </div>
          <div className="ostats__cell">
            <strong>{stats.autoDismissed}</strong>
            <span>Auto-muted</span>
            <em>by a judgment already made</em>
          </div>
        </div>
      )}

      {findings.loading ? (
        <div className="panel" style={{ height: 160, opacity: 0.4 }} />
      ) : items.length === 0 ? (
        <EmptyState
          title="The map agrees with your systems"
          body="Drift checks run every ten minutes per connector and cost no model requests, so this keeps running on a day the model quota is spent. Nothing is currently in dispute."
          action={{ href: "/app/graph", label: "Look at the map →" }}
        />
      ) : (
        items.map((finding) => {
          const shape = shapeOf(finding);
          const copy = SHAPE_COPY[shape] ?? SHAPE_COPY.changed;
          const { kind, name } = readableScope(finding.scope);

          return (
            <article
              className="queue__row"
              key={finding.id}
              data-testid={`drift-finding-${finding.id}`}
            >
              <div>
                <div className="queue__head">
                  <span
                    className="tag"
                    style={{ color: copy?.tone, borderColor: copy?.tone }}
                  >
                    {copy?.label}
                  </span>
                  <span className="queue__who">
                    <strong style={{ fontFamily: "var(--font-mono)", fontSize: 13.5 }}>
                      {name}
                    </strong>
                    <span>
                      {kind} · {finding.instanceName} ({finding.connector}) ·{" "}
                      {timeAgo(finding.createdAt)}
                    </span>
                  </span>
                </div>

                <p className="dim" style={{ fontSize: 13.5, margin: "2px 0 0" }}>
                  {copy?.body}
                </p>

                {finding.budgetExhaustedAt && (
                  <p
                    className="dim"
                    style={{ fontSize: 12.5, marginTop: 6, color: "var(--warn)" }}
                  >
                    An investigation ran out of budget before reaching a verdict. It
                    recorded no judgment, so this was left for you rather than muted.
                  </p>
                )}

                <div className="queue__meta">
                  <span className="tag tag--ghost" title="The full scope this covers">
                    {finding.scope}
                  </span>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn btn--ink btn--tiny"
                    disabled={busy}
                    onClick={() => void resolve(finding, "correct")}
                    data-testid="drift-correct"
                  >
                    The change was real
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--tiny"
                    disabled={busy}
                    onClick={() => {
                      setDismissing(finding);
                      setReason("");
                    }}
                    data-testid="drift-dismiss"
                  >
                    Benign — mute this
                  </button>
                </div>
              </div>
            </article>
          );
        })
      )}

      {dismissing && (
        <Overlay label="Dismiss this finding" onClose={() => setDismissing(null)}>
          <h2>Why is this benign?</h2>
          <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
            This mutes the same kind of change to{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>
              {readableScope(dismissing.scope).name}
            </code>{" "}
            for 30 days. The reason is required because a dismissal without one cannot be
            told apart from an investigation that gave up.
          </p>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. staging column, never read by anything"
            aria-label="Why this change is benign"
            style={{
              width: "100%",
              border: "1px solid var(--line)",
              borderRadius: 10,
              padding: "9px 12px",
              font: "inherit",
              fontSize: 14,
            }}
            data-testid="drift-dismiss-reason"
          />
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              type="button"
              className="btn btn--ink btn--tiny"
              disabled={reason.trim().length < 3 || busy}
              onClick={() => void resolve(dismissing, "dismiss")}
              data-testid="drift-dismiss-submit"
            >
              Mute for 30 days
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => setDismissing(null)}
            >
              Cancel
            </button>
          </div>
        </Overlay>
      )}
    </>
  );
}
