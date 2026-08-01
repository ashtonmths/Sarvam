"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EmptyState, Kbd, PageHead } from "../../../../components/app/ui";
import { DEPARTURE_EDGES } from "../../../../lib/mock/data";
import { useHasGraph } from "../../../../lib/queries";
import { useSession } from "../../../../lib/session";

/**
 * The exit-interview fan-out: N concurrent Historian loops over the departing
 * person's sole-source edges. Quota states are designed states, never
 * spinners: refused-at-preflight offers the subset that fits, skipped edges
 * are counted separately from given-up ones.
 */

type CardState = "queued" | "running" | "draft" | "give_up" | "skipped_quota";

interface Card {
  edgeId: number;
  label: string;
  state: CardState;
  lines: string[];
}

const STREAM_SCRIPT = [
  "get_edge_context — reading edge provenance and endpoints",
  "search_slack — scanning #finance-alerts history",
  "fetch_thread — best candidate thread found",
  "verify_span — containment check against permalink",
];

// Scripted terminal states so the demo always shows the full vocabulary.
const OUTCOME_BY_INDEX: CardState[] = [
  "draft",
  "draft",
  "give_up",
  "draft",
  "skipped_quota",
  "skipped_quota",
];

const DAILY_REMAINING = 30;
const REQUESTS_PER_EDGE = 5;

/** People selectable for an exit interview, with their sole-source edge count. */
const PEOPLE = [
  {
    id: "U02MARCUS",
    name: "Marcus Chen",
    note: "departed March 2026",
    soleSource: DEPARTURE_EDGES.length,
  },
  { id: "U01PRIYA", name: "Priya Sharma", note: "active", soleSource: 0 },
];

export default function DeparturePage() {
  const { org } = useSession();
  const { hasGraph } = useHasGraph(org?.id ?? null);
  const [person, setPerson] = useState(PEOPLE[0]!);
  const [started, setStarted] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  const estimated = DEPARTURE_EDGES.length * REQUESTS_PER_EDGE;
  const edgesThatFit = Math.floor(DAILY_REMAINING / REQUESTS_PER_EDGE);
  const overQuota = estimated > DAILY_REMAINING;

  useEffect(() => () => timers.current.forEach(clearInterval), []);

  function start(edges: typeof DEPARTURE_EDGES) {
    setStarted(true);
    const initial: Card[] = DEPARTURE_EDGES.map((e, i) => ({
      edgeId: e.edgeId,
      label: e.label,
      state: edges.some((x) => x.edgeId === e.edgeId)
        ? i < 5
          ? "running"
          : "queued"
        : "skipped_quota",
      lines: [],
    }));
    setCards(initial);

    initial.forEach((card, idx) => {
      if (card.state === "skipped_quota") return;
      let step = 0;
      const t = setInterval(
        () => {
          step += 1;
          setCards((prev) =>
            prev.map((c, i) => {
              if (i !== idx) return c;
              if (c.state === "queued") return { ...c, state: "running" };
              if (step <= STREAM_SCRIPT.length) {
                return { ...c, lines: STREAM_SCRIPT.slice(0, step) };
              }
              clearInterval(t);
              const scripted = OUTCOME_BY_INDEX[idx] ?? "draft";
              const outcome: CardState =
                scripted === "skipped_quota" ? "draft" : scripted;
              return { ...c, state: outcome };
            }),
          );
          if (step > STREAM_SCRIPT.length) clearInterval(t);
        },
        700 + idx * 260,
      );
      timers.current.push(t);
    });
  }

  const settled = cards.filter((c) =>
    ["draft", "give_up", "skipped_quota"].includes(c.state),
  );
  const draftCount = cards.filter((c) => c.state === "draft").length;
  const gaveUp = cards.filter((c) => c.state === "give_up").length;
  const skipped = cards.filter((c) => c.state === "skipped_quota").length;
  const doneAll = started && settled.length === cards.length && cards.length > 0;

  if (!hasGraph) {
    return (
      <>
        <PageHead
          title="Exit interview"
          sub="Fan out Historian over a departing person's sole-source edges."
        />
        <EmptyState
          title="No people on the map yet"
          body="Sadhak learns who explains what from mined rationale. Connect a system first — the concentration risk surfaces on its own."
          action={{ href: "/app/onboarding", label: "Connect a system →" }}
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Exit interview"
        sub="Pick a person; Sadhak lists the edges only they ever explained — investigate them before the knowledge decays further."
      >
        <Link href="/app/agents" className="btn btn--ghost btn--small">
          ← All runs
        </Link>
      </PageHead>

      {!started && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div
            style={{
              display: "flex",
              gap: 14,
              alignItems: "flex-end",
              flexWrap: "wrap",
              marginBottom: 14,
            }}
          >
            <div className="field-inline">
              <label htmlFor="dep-person">Departing person</label>
              <select
                id="dep-person"
                value={person.id}
                onChange={(e) =>
                  setPerson(PEOPLE.find((p) => p.id === e.target.value) ?? PEOPLE[0]!)
                }
                data-testid="departure-person-picker"
              >
                {PEOPLE.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.note}
                  </option>
                ))}
              </select>
            </div>
            <p className="panel__caption" style={{ margin: 0 }}>
              {person.soleSource} sole-source edges · fan-out runs ~5 loops concurrently,
              server-side bounded
            </p>
          </div>

          {person.soleSource === 0 ? (
            <div className="empty" style={{ padding: "26px 20px" }}>
              <strong>No sole-source edges</strong>
              <p>
                Everything {person.name} has explained, someone else has explained too.
                That is the goal state — nothing to investigate.
              </p>
            </div>
          ) : overQuota ? (
            <div
              className="banner banner--warn"
              role="status"
              data-testid="departure-quota-offer"
            >
              {DEPARTURE_EDGES.length} edges need ~{estimated} model requests;{" "}
              {DAILY_REMAINING} remain today. Investigate the {edgesThatFit}{" "}
              highest-criticality now, or start the rest after the cap resets at 00:00
              UTC.
            </div>
          ) : (
            <p style={{ fontSize: 14, color: "var(--ink-soft)", marginBottom: 14 }}>
              Estimated ~{estimated} model requests; {DAILY_REMAINING} remain today.
            </p>
          )}

          {person.soleSource > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {overQuota ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ink"
                    onClick={() => {
                      start(DEPARTURE_EDGES.slice(0, edgesThatFit));
                    }}
                    data-testid="departure-start-subset"
                  >
                    Investigate the {edgesThatFit} highest-criticality now
                  </button>
                  <button type="button" className="btn btn--ghost" disabled>
                    Start the rest after reset
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--ink"
                  onClick={() => start(DEPARTURE_EDGES)}
                >
                  Start investigation
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {started && (
        <>
          <div className="banner banner--info" role="status">
            Drafts produced here are <strong>pending</strong> — they queue for your review
            and do not count toward coverage until confirmed.
          </div>

          <div className="fanout-grid" aria-live="polite" data-testid="departure-grid">
            {cards.map((c) => (
              <div
                key={c.edgeId}
                className={`fanout-card${
                  c.state === "draft"
                    ? " fanout-card--green"
                    : c.state === "give_up"
                      ? " fanout-card--amber"
                      : c.state === "skipped_quota"
                        ? " fanout-card--skipped"
                        : ""
                }`}
                data-testid={`departure-card-${c.edgeId}`}
              >
                <span className="fanout-card__edge">{c.label}</span>

                {c.state === "queued" && (
                  <span className="dim" style={{ fontSize: 12.5 }}>
                    Queued — position in line
                  </span>
                )}

                {c.state === "running" && (
                  <div className="fanout-card__stream">
                    <span className="pulse-dot" aria-hidden="true" />
                    investigating…
                    {c.lines.map((l, i) => (
                      <div key={i} className="mono" style={{ fontSize: 11 }}>
                        {l}
                      </div>
                    ))}
                  </div>
                )}

                {c.state === "draft" && (
                  <>
                    <span className="tag tag--green">draft queued</span>
                    <Link
                      href="/app/queue"
                      style={{
                        fontSize: 13,
                        color: "var(--thread)",
                        textDecoration: "underline",
                      }}
                    >
                      Review in queue →
                    </Link>
                  </>
                )}

                {c.state === "give_up" && (
                  <>
                    <span className="tag tag--amber">gave up</span>
                    <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                      No written trace found — declining to guess.{" "}
                      <Link
                        href="/app/graph?filter=unexplained"
                        style={{ textDecoration: "underline" }}
                      >
                        Edge stays unexplained
                      </Link>
                    </span>
                  </>
                )}

                {c.state === "skipped_quota" && (
                  <>
                    <span className="tag tag--ghost">skipped: daily model quota</span>
                    <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                      Nothing was investigated, so nothing was given up. Resumable
                      tomorrow.
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>

          {doneAll && (
            <div
              className="banner banner--info"
              style={{ marginTop: 18 }}
              role="status"
              data-testid="departure-summary"
            >
              {cards.length - skipped} investigated · {draftCount} drafts queued for your
              review · {gaveUp} given up — these edges remain unexplained
              {skipped > 0 && (
                <> · {skipped} skipped: daily model quota, resumable tomorrow</>
              )}
            </div>
          )}
        </>
      )}

      {!started && (
        <p className="dim" style={{ fontSize: 12.5 }}>
          Tip: cards settle in place — green deep-links to its draft in the queue, amber{" "}
          <Kbd>give_up</Kbd> shows its reason inline. Quota-skipped edges are their own
          state, visually distinct from both.
        </p>
      )}
    </>
  );
}
