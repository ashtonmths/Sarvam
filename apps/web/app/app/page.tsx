"use client";

import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  ChartColumn,
  ChevronDown,
  Clock,
  Radar,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PulseChart, type PulsePoint } from "../../components/app/pulse-chart";
import { EmptyState, VerdictBadge } from "../../components/app/ui";
import type {
  Coverage,
  DecisionRow,
  DriftSummary,
  HistorianRun,
  Page,
  SeriesResponse,
  VerdictName,
} from "../../lib/api";
import { useGraphStats, useQuery } from "../../lib/queries";
import { useSession } from "../../lib/session";

interface WatchRow {
  node: { id: number; name: string; kind: string; criticality: number };
  downstream: number;
  maxImpact: number;
  verdict: VerdictName;
}

const OUTCOME_DOT: Record<string, string> = {
  done: "var(--approve)",
  running: "var(--thread)",
  queued: "var(--ink-faint)",
  cancelled: "var(--warn)",
};

// One family, one weight. The shield is the gate's own metaphor, so the three
// verdicts differ only by what is inside it.
const VERDICT_ICON: Record<VerdictName, React.ReactNode> = {
  APPROVE: <ShieldCheck size={18} strokeWidth={1.8} aria-hidden />,
  WARN: <ShieldAlert size={18} strokeWidth={1.8} aria-hidden />,
  BLOCK: <ShieldX size={18} strokeWidth={1.8} aria-hidden />,
};

const DAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Local calendar day, not UTC — `toISOString` would shift the date west of Greenwich. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function dayOffset(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

function shortDate(d: Date): string {
  return `${MONTH[d.getMonth()]} ${d.getDate()}`;
}

/** Rollup points keyed by calendar day, so a gap reads as zero rather than vanishing. */
function byDay(res: SeriesResponse | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of res?.points ?? []) m.set(p.day.slice(0, 10), p.value);
  return m;
}

function changeTitle(change: Record<string, string>): string {
  const tail = String(change.externalId ?? change.target ?? "")
    .split("/")
    .filter(Boolean)
    .pop();
  const op = change.operation ?? "change";
  return tail ? `${op} ${tail}` : op;
}

export default function OverviewPage() {
  const { org, user } = useSession();
  const { data: stats, loading } = useGraphStats(org?.id ?? null);

  const decisions = useQuery<Page<DecisionRow>>(
    org ? "/api/gate/decisions?limit=6" : null,
    [org?.id],
  );
  // Ranked by the gate's own arithmetic — a real traversal per candidate,
  // computed server-side rather than approximated here.
  const watchlist = useQuery<{ items: WatchRow[] }>(
    org ? "/api/graph/watchlist?limit=4" : null,
    [org?.id],
  );
  const runs = useQuery<{ items: HistorianRun[] }>(org ? "/api/historian/runs" : null, [
    org?.id,
  ]);
  // Drift is the other source of work the gate generates, and it is the one
  // that means the map itself is in dispute.
  const drift = useQuery<DriftSummary>(org ? "/api/drift/summary" : null, [org?.id]);
  const coverage = useQuery<Coverage>(org ? "/api/metrics/coverage" : null, [org?.id]);
  const approved = useQuery<SeriesResponse>(
    org ? "/api/metrics/series/gate_approved" : null,
    [org?.id],
  );
  const warned = useQuery<SeriesResponse>(
    org ? "/api/metrics/series/gate_warned" : null,
    [org?.id],
  );
  const blocked = useQuery<SeriesResponse>(
    org ? "/api/metrics/series/gate_blocked" : null,
    [org?.id],
  );

  const [range, setRange] = useState<"week" | "month">("week");
  const [picked, setPicked] = useState<number | null>(null);
  const [openRow, setOpenRow] = useState<number | null>(0);

  if (loading) {
    return (
      <>
        <div className="ovhead">
          <h1>Overview</h1>
        </div>
        <div className="ov" aria-hidden>
          <div className="skel ov__span2" style={{ height: 420 }} />
          <div className="skel" style={{ height: 420 }} />
          <div className="skel" style={{ height: 300 }} />
          <div className="skel" style={{ height: 300 }} />
          <div className="skel" style={{ height: 300 }} />
        </div>
      </>
    );
  }

  const nodeCount = stats?.nodes.total ?? 0;

  if (nodeCount === 0) {
    return (
      <>
        <div className="ovhead">
          <div>
            <h1>Overview</h1>
            <p className="ovhead__sub">
              This org has no crawled systems yet, so there is no graph and nothing to
              gate.
            </p>
          </div>
        </div>
        <EmptyState
          title="Connect your first system"
          body="Sadhak crawls n8n, Airtable and Postgres read-only, assembles the dependency map, and gates the changes that would break it."
          action={{ href: "/app/settings/connectors", label: "Add a connector →" }}
        />
      </>
    );
  }

  /* ------------------------------------------------------------ figures */

  const staleCount = stats?.nodes.byState.stale ?? 0;
  const connectors = Object.entries(stats?.nodes.byConnector ?? {});
  const kinds = Object.entries(stats?.nodes.byKind ?? {}).sort((a, b) => b[1] - a[1]);
  const maxKind = kinds[0]?.[1] ?? 1;

  const approveDays = byDay(approved.data);
  const warnDays = byDay(warned.data);
  const blockDays = byDay(blocked.data);
  const totalFor = (day: string) =>
    (approveDays.get(day) ?? 0) + (warnDays.get(day) ?? 0) + (blockDays.get(day) ?? 0);

  /* ---------------------------------------------------------- the chart */

  const span = range === "week" ? 7 : 28;
  const bucket = range === "week" ? 1 : 7;

  const points: PulsePoint[] = [];
  for (let i = 0; i < span; i += bucket) {
    const start = dayOffset(-(span - 1 - i));
    const days: string[] = [];
    for (let k = 0; k < bucket; k++) days.push(isoDay(dayOffset(-(span - 1 - i) + k)));
    const end = dayOffset(-(span - 1 - i) + bucket - 1);
    points.push({
      key: isoDay(start),
      label: range === "week" ? (DAY_LETTER[start.getDay()] ?? "") : `W${i / bucket + 1}`,
      full:
        range === "week" ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`,
      value: days.reduce((sum, d) => sum + totalFor(d), 0),
    });
  }

  const periodTotal = points.reduce((sum, p) => sum + p.value, 0);
  let priorTotal = 0;
  for (let i = 0; i < span; i++)
    priorTotal += totalFor(isoDay(dayOffset(-(span * 2 - 1 - i))));
  const delta =
    priorTotal > 0 ? Math.round(((periodTotal - priorTotal) / priorTotal) * 100) : null;

  // Default focus lands on the busiest bucket, which is the one worth reading.
  const peak = points.reduce(
    (best, p, i) => (p.value > (points[best]?.value ?? 0) ? i : best),
    0,
  );
  const active = picked ?? peak;
  const periodWord = range === "week" ? "week" : "month";

  /* ------------------------------------------------------- verdict mix */

  // 14 days, not 30: at this card's width thirty bars are hairlines, and a
  // single busy day renders as a spike rather than as a column.
  const MIX_DAYS = 14;
  const mixDays = Array.from({ length: MIX_DAYS }, (_, i) =>
    isoDay(dayOffset(-(MIX_DAYS - 1 - i))),
  );
  const mixRaw = [
    { key: "approve", label: "Approved", days: approveDays },
    { key: "warn", label: "Warned", days: warnDays },
    { key: "block", label: "Blocked", days: blockDays },
  ].map((col) => {
    const values = mixDays.map((d) => col.days.get(d) ?? 0);
    return {
      ...col,
      values,
      total: values.reduce((a, b) => a + b, 0),
      max: Math.max(...values, 1),
    };
  });
  const mixTotal = mixRaw.reduce((sum, c) => sum + c.total, 0);
  const mix = mixRaw.map((col) => ({
    ...col,
    share: mixTotal > 0 ? Math.round((col.total / mixTotal) * 100) : 0,
  }));

  /* ------------------------------------------------------------- lists */

  const recent = (decisions.data?.items ?? []).slice(0, 4);
  const watch = watchlist.data?.items ?? [];
  const recentRuns = (runs.data?.items ?? []).slice(0, 3);

  const confirmed = coverage.data?.coverageConfirmed ?? 0;
  const totalEdges = coverage.data?.totalEdges ?? 0;
  const coveragePct = totalEdges > 0 ? Math.round((confirmed / totalEdges) * 100) : 0;

  const openDrift = drift.data?.open ?? 0;
  const firstName = user?.name?.split(/\s+/)[0] ?? "there";

  return (
    <>
      <div className="ovhead">
        <div>
          <h1>Overview</h1>
          <p className="ovhead__sub">
            Good to see you, {firstName}. This is the gate&rsquo;s view of{" "}
            {org?.name ?? "your org"}: what is mapped, what it decided, and what the
            agents are doing about the gaps.
          </p>
        </div>
        <div className="ovhead__side">
          <span className="ovhead__date">
            <CalendarDays size={14} strokeWidth={1.8} aria-hidden />
            {shortDate(new Date())}, {new Date().getFullYear()}
          </span>
          <Link href="/app/simulate" className="pillbtn" data-testid="overview-graph-cta">
            Simulate a change
            <ArrowRight size={14} strokeWidth={1.9} aria-hidden />
          </Link>
        </div>
      </div>

      {openDrift > 0 && (
        <div className="driftbar" data-testid="overview-drift">
          <span className="driftbar__icon">
            <Radar size={17} strokeWidth={1.7} aria-hidden />
          </span>
          <span className="driftbar__body">
            <strong>
              {openDrift} finding{openDrift === 1 ? "" : "s"} say the map is out of date
            </strong>
            <span>
              The live systems and the map disagree
              {drift.data?.lastCheckedAt
                ? ` · checked ${timeAgo(drift.data.lastCheckedAt)}`
                : ""}
              {(drift.data?.autoDismissed ?? 0) > 0 &&
                ` · ${drift.data?.autoDismissed} muted by a judgment you already made`}
            </span>
          </span>
          <Link href="/app/drift" className="driftbar__go">
            Open the queue
            <ArrowRight size={14} strokeWidth={1.9} aria-hidden />
          </Link>
        </div>
      )}

      <div className="ov">
        {/* ------------------------------------------------ decision tracker */}
        <section className="ovcard track ov__span2" aria-label="Decision volume">
          <div className="track__top">
            <div>
              <span className="track__badge">
                <ChartColumn size={18} strokeWidth={1.8} aria-hidden />
              </span>
              <h2 className="track__title">Decision Tracker</h2>
              <p className="track__sub">
                Every verdict the gate issued, day by day. Click a column to read its
                count.
              </p>
            </div>
            <fieldset className="rangepick" aria-label="Range">
              <button
                type="button"
                data-on={range === "week" || undefined}
                onClick={() => {
                  setRange("week");
                  setPicked(null);
                }}
              >
                Week
              </button>
              <button
                type="button"
                data-on={range === "month" || undefined}
                onClick={() => {
                  setRange("month");
                  setPicked(null);
                }}
              >
                Month
              </button>
            </fieldset>
          </div>

          <div className="track__body">
            <div className="track__figure">
              <strong className="track__pct">
                {delta === null
                  ? periodTotal.toLocaleString()
                  : `${delta >= 0 ? "+" : ""}${delta}%`}
              </strong>
              <span className="track__pct-note">
                {delta === null
                  ? `decision${periodTotal === 1 ? "" : "s"} this ${periodWord}. No earlier ${periodWord} to compare against yet.`
                  : `This ${periodWord}'s volume is ${delta >= 0 ? "higher" : "lower"} than the ${periodWord} before it.`}
              </span>
            </div>
            <PulseChart
              points={points}
              active={active}
              onPick={setPicked}
              unit="decisions"
            />
          </div>

          <div className="ostats ostats--inline">
            <div className="ostats__cell">
              <strong>{nodeCount}</strong>
              <span>Nodes mapped</span>
              <em>
                across {connectors.length} connector{connectors.length === 1 ? "" : "s"}
              </em>
            </div>
            <div className="ostats__cell">
              <strong>{stats?.edges.total ?? 0}</strong>
              <span>Dependencies</span>
              <em>{stats?.edges.byProvenance.static_parse ?? 0} statically parsed</em>
            </div>
            <div className="ostats__cell">
              <strong>{staleCount}</strong>
              <span>Stale entities</span>
              <em>
                {staleCount === 0
                  ? "nothing has disappeared"
                  : "tombstoned, never deleted"}
              </em>
            </div>
            <div className="ostats__cell">
              <strong>{stats?.unresolvedRefs ?? 0}</strong>
              <span>Unresolved refs</span>
              <em>we refused to guess at these</em>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ recent verdicts */}
        <section className="ovcard" aria-label="Recent decisions">
          <div className="ovcard__head">
            <h2 className="ovcard__title">Recent decisions</h2>
            <Link href="/app/decisions" className="ovcard__more">
              See all
            </Link>
          </div>

          {recent.length === 0 ? (
            <p className="ovcard__empty">
              Nothing has been through the gate yet. Simulate a change to see a verdict.
            </p>
          ) : (
            <ul className="declist">
              {recent.map((d, i) => (
                <li
                  key={d.id}
                  className="declist__row"
                  data-open={openRow === i || undefined}
                >
                  <button
                    type="button"
                    className="declist__head"
                    aria-expanded={openRow === i}
                    onClick={() => setOpenRow(openRow === i ? null : i)}
                    data-testid={`overview-decision-${i}`}
                  >
                    <span
                      className={`declist__tile declist__tile--${d.verdict.toLowerCase()}`}
                    >
                      {VERDICT_ICON[d.verdict]}
                    </span>
                    <span className="declist__id">
                      <span className="declist__name">
                        <em>{changeTitle(d.change)}</em>
                        <VerdictBadge verdict={d.verdict} />
                      </span>
                      <span className="declist__sub">
                        {d.mode} · {d.computedInMs}ms
                      </span>
                    </span>
                    <span className="declist__caret">
                      <ChevronDown size={15} strokeWidth={1.9} aria-hidden />
                    </span>
                  </button>

                  <div className="declist__body">
                    <div className="declist__inner">
                      <div className="declist__pad">
                        <div className="declist__tags">
                          <span className="dchip">
                            {d.dryRun ? "dry run" : "executed"}
                          </span>
                          {Object.entries(d.change)
                            .filter(([k]) => k !== "externalId" && k !== "operation")
                            .slice(0, 3)
                            .map(([k, v]) => (
                              <span className="dchip" key={k}>
                                {k}: {String(v)}
                              </span>
                            ))}
                        </div>
                        <p className="declist__note">
                          The gate traversed the dependency map for this change and
                          returned <strong>{d.verdict}</strong> in {d.computedInMs}ms
                          {d.actor ? `, for ${d.actor}` : ""}.
                        </p>
                        <div className="declist__meta">
                          <span>
                            <Clock size={13} strokeWidth={1.8} aria-hidden />
                            {timeAgo(d.createdAt)}
                          </span>
                          <span>{d.change.connector ?? d.mode}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --------------------------------------------- blast radius watch */}
        <section className="ovcard" aria-label="Blast radius watchlist">
          <div className="ovcard__head">
            <h2 className="ovcard__title">Blast radius</h2>
            <Link href="/app/simulate" className="ovcard__more">
              Simulate
            </Link>
          </div>
          <p className="ovcard__caption">
            The most dangerous things to touch right now, ranked by the gate&rsquo;s own
            arithmetic over your real graph.
          </p>

          {watch.length === 0 ? (
            <p className="ovcard__empty">Nothing in this graph has dependents yet.</p>
          ) : (
            <div className="wl">
              {watch.map((w, i) => (
                <div
                  className="wl__row"
                  key={w.node.id}
                  data-testid={`overview-watch-${i}`}
                >
                  <span className="wl__rank">{String(i + 1).padStart(2, "0")}</span>
                  <span className="wl__id">
                    <span className="wl__name">
                      <em>{w.node.name}</em>
                      <VerdictBadge verdict={w.verdict} />
                    </span>
                    <span className="wl__sub">
                      {w.node.kind} · {w.downstream} downstream
                    </span>
                  </span>
                  <span className="wl__meter" aria-hidden>
                    <i
                      style={{
                        width: `${Math.round(w.maxImpact * 100)}%`,
                        background:
                          w.verdict === "BLOCK" ? "var(--block)" : "var(--warn)",
                      }}
                    />
                  </span>
                  <b className="wl__impact">{w.maxImpact.toFixed(2)}</b>
                  <Link
                    href={`/app/simulate?node=${w.node.id}`}
                    className="wl__go"
                    aria-label={`Simulate a change to ${w.node.name}`}
                  >
                    <ArrowUpRight size={15} strokeWidth={2} aria-hidden />
                  </Link>
                </div>
              ))}
            </div>
          )}
          <p className="panel__foot">
            impact = criticality × path confidence × 0.6^(hops−1)
          </p>
        </section>

        {/* --------------------------------------------------- coverage card */}
        <section className="promo" aria-label="Rationale coverage">
          <span className="promo__eyebrow">Rationale coverage</span>
          <div className="promo__figure">
            <strong>{coveragePct}%</strong>
            <span>
              {confirmed}/{totalEdges} edges confirmed
            </span>
          </div>
          <div className="promo__meter" aria-hidden>
            <i style={{ width: `${coveragePct}%` }} />
          </div>
          <p className="promo__body">
            Only rationale a human confirmed counts. The historians draft the rest, and
            say so honestly when they cannot.
          </p>
          <Link
            href="/app/agents"
            className="promo__cta"
            data-testid="shell-coverage-card"
          >
            Run the historians
            <i>
              <ArrowRight size={14} strokeWidth={2} aria-hidden />
            </i>
          </Link>
        </section>

        {/* ------------------------------------------------------ verdict mix */}
        <section className="ovcard" aria-label="Verdict mix">
          <div className="ovcard__head">
            <h2 className="ovcard__title">Verdict mix</h2>
            <span className="ovcard__chip">
              <CalendarDays size={13} strokeWidth={1.7} aria-hidden />
              Last 14 days
            </span>
          </div>
          <div className="mix">
            {mix.map((col) => (
              <div className={`mix__col mix__col--${col.key}`} key={col.key}>
                <span className="mix__label">{col.label}</span>
                <strong className="mix__value">{col.total.toLocaleString()}</strong>
                {/* the column heading already says which verdict, so the bare
                    percentage reads fine and survives a narrow column */}
                <span className="mix__share">
                  {mixTotal > 0 ? `${col.share}% of all` : "none yet"}
                </span>
                <span className="mix__bars" aria-hidden>
                  {col.values.map((v, i) => (
                    <i
                      key={mixDays[i]}
                      style={{
                        height: `${Math.max(4, (v / col.max) * 100)}%`,
                        opacity: v === 0 ? 0.22 : 0.9,
                      }}
                    />
                  ))}
                </span>
              </div>
            ))}
          </div>
          <p className="panel__foot">
            One bar per day, scaled within its own column ·{" "}
            <Link href="/app/metrics">the full metrics →</Link>
          </p>
        </section>

        {/* ------------------------------------------------------ agent runs */}
        <section className="ovcard ov__span2 ov__auto" aria-label="Agents at work">
          <div className="ovcard__head">
            <h2 className="ovcard__title">Agents at work</h2>
            <Link href="/app/agents" className="ovcard__more">
              All runs
            </Link>
          </div>
          <p className="ovcard__caption">
            What the historians did last, honest failures included.
          </p>

          {recentRuns.length === 0 ? (
            <p className="ovcard__empty">
              No investigations yet. Historian runs after a crawl, or when you start an
              exit interview.
            </p>
          ) : (
            recentRuns.map((run) => (
              <div className="arun" key={run.id}>
                <span className="arun__tile">
                  {run.kind === "exit_interview" ? (
                    <Sparkles size={17} strokeWidth={1.8} aria-hidden />
                  ) : (
                    <Bot size={17} strokeWidth={1.8} aria-hidden />
                  )}
                  <i
                    className="arun__dot"
                    style={{ background: OUTCOME_DOT[run.state] ?? "var(--ink-faint)" }}
                    aria-hidden
                  />
                </span>
                <span className="arun__body">
                  <strong>
                    {run.kind === "exit_interview"
                      ? "Exit interview"
                      : "Edge investigation"}
                  </strong>
                  <span>
                    {run.edgesProposed} drafted · {run.edgesGaveUp} honestly unexplained
                    {run.edgesSkippedQuota > 0 &&
                      ` · ${run.edgesSkippedQuota} quota-skipped`}
                  </span>
                </span>
                <span className="arun__when">
                  {run.requestsUsed} req · {timeAgo(run.createdAt)}
                </span>
              </div>
            ))
          )}
        </section>

        {/* ------------------------------------------------ map composition */}
        <section className="ovcard ov__auto" aria-label="Map composition">
          <div className="ovcard__head">
            <h2 className="ovcard__title">What the map is made of</h2>
            <Link href="/app/graph" className="ovcard__more">
              Explore
            </Link>
          </div>
          <p className="ovcard__caption">Live counts from the last crawl.</p>
          {kinds.map(([kind, count]) => (
            <div className="kindbar" key={kind}>
              <span className="kindbar__label">{kind}</span>
              <span className="kindbar__track" aria-hidden>
                <i
                  style={{
                    width: `${Math.round((count / maxKind) * 100)}%`,
                  }}
                />
              </span>
              <span className="kindbar__count">{count}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
