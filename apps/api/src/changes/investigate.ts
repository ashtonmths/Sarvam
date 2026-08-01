import { log } from "../log.js";
import {
  type CheckpointRow,
  candidatesBefore,
  type Window,
  windowsFrom,
} from "./checkpoints.js";
import { type ChangeRow, changesBetween, pathsForChanges } from "./store.js";

/**
 * The expanding-window investigation.
 *
 * The whole idea is to start with the smallest history that could contain the
 * cause and widen only when it does not. Searching everything is both slower
 * and *less accurate*: the further back a search reaches, the more changes it
 * finds that look plausible and had nothing to do with the incident. Bounding
 * the window first is a precision improvement that happens to also be cheap.
 *
 * This module chooses and scores; it never talks to a model. That separation
 * is what makes the ranking testable — the interesting behaviour is which
 * changes surface and when the search stops, and neither needs an LLM to
 * verify.
 */

export interface InvestigationLimits {
  /** Rounds of widening. Each one reaches further back than the last. */
  maxWindows: number;
  /** How far back the search may ever reach. */
  maxLookbackMs: number;
  /** Changes carried into the report per round. */
  maxChangesPerWindow: number;
  /** Stop as soon as a round scores at least this well. */
  confidenceTarget: number;
}

export const DEFAULT_LIMITS: InvestigationLimits = {
  maxWindows: 4,
  maxLookbackMs: 30 * 24 * 60 * 60 * 1000,
  maxChangesPerWindow: 25,
  confidenceTarget: 0.6,
};

export interface ScoredChange {
  change: ChangeRow;
  paths: string[];
  score: number;
  /** Why this change surfaced, in the report's own words. */
  why: string[];
}

export interface Round {
  window: Window;
  /** Changes scored in this window. Equals the true total unless truncated. */
  totalInWindow: number;
  /** The window held more than could be scanned, so this round is partial. */
  truncated: boolean;
  candidates: ScoredChange[];
  confidence: number;
}

export interface Investigation {
  incidentAt: Date;
  rounds: Round[];
  /** The round the search settled on, or null when nothing scored. */
  conclusion: Round | null;
  stoppedBecause:
    | "found"
    | "windows_exhausted"
    | "lookback_limit"
    | "scan_limit"
    | "no_changes";
  /** Stated plainly, because an unbounded claim from a bounded search is a lie. */
  caveat: string | null;
}

/** How many checkpoints to consider before building the widening ladder. */
const CANDIDATE_POOL = 50;

/** Changes scored per round. One more is fetched, to detect the cut. */
const SCAN_LIMIT = 500;

/**
 * Words that carry no signal about *which* change broke something.
 *
 * Two kinds are dangerous here, and both got through a bare length filter.
 * English filler ("the", "was", "not") matches half of all commit messages.
 * Structural path words ("api", "src", "lib", "app", "web") match every file
 * in a directory — and paths score higher than prose, precisely because
 * editing a file is stronger evidence than mentioning one.
 *
 * The failure was not subtle: "the api is down" gave terms the, api, down,
 * and every commit under `apps/api/` matched on three paths plus a title word
 * plus proximity, scoring 0.85. That cleared the confidence target, so the
 * search reported `found`, emitted no caveat, and named whichever commit was
 * most recent — in the language of evidence. Confidently wrong is the one
 * outcome this module exists to avoid.
 */
const STOPWORDS = new Set([
  // Filler.
  "the",
  "and",
  "but",
  "for",
  "not",
  "was",
  "were",
  "are",
  "its",
  "our",
  "this",
  "that",
  "with",
  "from",
  "have",
  "has",
  "had",
  "been",
  "being",
  "since",
  "when",
  "what",
  "why",
  "how",
  "all",
  "any",
  "can",
  "did",
  "does",
  "get",
  "got",
  "now",
  "out",
  "off",
  "over",
  "some",
  "than",
  "then",
  "them",
  "they",
  "you",
  "your",
  // Incident vocabulary: true of every incident, so it distinguishes nothing.
  "down",
  "broke",
  "broken",
  "error",
  "errors",
  "fail",
  "failed",
  "failing",
  "issue",
  "issues",
  "bug",
  "prod",
  "production",
  "outage",
  "incident",
  "slow",
  "empty",
  "missing",
  "wrong",
  "bad",
  "server",
  "service",
  // Structural path words. These match whole directories.
  "api",
  "src",
  "lib",
  "app",
  "apps",
  "web",
  "www",
  "core",
  "utils",
  "test",
  "tests",
  "dist",
  "build",
  "index",
  "main",
  "config",
  "common",
  "shared",
]);

export function usefulTerms(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const term of raw) {
    // Trailing punctuation survives the split; "500ing." matches nothing.
    const cleaned = term.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, "");
    if (cleaned.length < 3) continue;
    if (STOPWORDS.has(cleaned)) continue;
    seen.add(cleaned);
  }
  return [...seen];
}

export interface Signals {
  /** Words from the incident: the failing table, service, or error text. */
  terms: string[];
  /** Repositories worth searching. Empty means every repository in the org. */
  repoIds?: number[];
  /** Path fragments the affected thing is known to live under. */
  pathHints?: string[];
}

/**
 * Runs the search, widening until something scores or a limit is hit.
 *
 * Every stop is named rather than implied. "We found nothing" and "we ran out
 * of budget before we could look" are completely different answers, and a
 * report that renders them identically is the failure mode this whole feature
 * exists to avoid.
 */
export async function investigate(
  orgId: number,
  incidentAt: Date,
  signals: Signals,
  limits: InvestigationLimits = DEFAULT_LIMITS,
): Promise<Investigation> {
  /**
   * Far more candidates than windows, then a ladder built across them.
   *
   * Fetching exactly `maxWindows` ranked by recency-weighted trust collapsed
   * the whole point of the feature: a deployment crawling hourly writes a
   * `crawl_healthy` checkpoint every hour, so the four best candidates were
   * always four crawls from the last few hours. Every window was minutes wide,
   * every one was empty, and the genuinely useful release checkpoint from last
   * week never entered the running — it was discarded before the loop, then
   * reported as "every available checkpoint was searched".
   */
  const candidates = await candidatesBefore(
    orgId,
    incidentAt,
    { repoId: signals.repoIds?.[0] ?? null },
    CANDIDATE_POOL,
  );

  const earliest = new Date(incidentAt.getTime() - limits.maxLookbackMs);
  const windows = windowsFrom(candidates, incidentAt, limits.maxWindows);

  const rounds: Round[] = [];
  let stoppedBecause: Investigation["stoppedBecause"] = "windows_exhausted";

  for (const window of windows) {
    // Clamped, not skipped: a checkpoint older than the lookback still gives a
    // useful search of everything inside the limit.
    const from = window.from < earliest ? earliest : window.from;
    const clamped = from > window.from;

    /**
     * One over the cap, so truncation is detectable rather than assumed.
     *
     * Reporting `all.length` as `totalInWindow` after a bare LIMIT was a
     * silent truncation reported as a total — and worse, since every window
     * ends at the incident and the query is newest-first, a saturated window
     * returns *identical* rows on every widening. The search would run four
     * rounds over the same 500 changes, never move its confidence, and report
     * `windows_exhausted` having examined the same set four times.
     */
    const fetched = await changesBetween(
      orgId,
      { from, to: window.to, ...(signals.repoIds ? { repoIds: signals.repoIds } : {}) },
      SCAN_LIMIT + 1,
    );
    const truncated = fetched.length > SCAN_LIMIT;
    const all = truncated ? fetched.slice(0, SCAN_LIMIT) : fetched;

    const round: Round = {
      window: clamped
        ? { ...window, from, reason: `${window.reason} (clamped to the lookback limit)` }
        : window,
      totalInWindow: all.length,
      truncated,
      candidates: [],
      confidence: 0,
    };

    if (all.length > 0) {
      const paths = await pathsForChanges(all.map((c) => c.id));
      round.candidates = rank(all, paths, signals, incidentAt).slice(
        0,
        limits.maxChangesPerWindow,
      );
      round.confidence = round.candidates[0]?.score ?? 0;
    }

    rounds.push(round);

    if (round.confidence >= limits.confidenceTarget) {
      stoppedBecause = "found";
      break;
    }
    /**
     * Widening past a saturated window is pointless work: the query is
     * newest-first and every window ends at the incident, so a wider one
     * returns exactly the same rows. Stop and say the search was capped.
     */
    if (truncated) {
      stoppedBecause = "scan_limit";
      break;
    }
    if (clamped) {
      stoppedBecause = "lookback_limit";
      break;
    }
  }

  const withAny = rounds.filter((r) => r.candidates.length > 0);
  const conclusion = withAny.sort((a, b) => b.confidence - a.confidence)[0] ?? null;

  /**
   * `every` on an empty array is true, so a ladder that produced no rounds at
   * all would report "nothing shipped in the searched window" — a confident
   * negative from a search that never ran. The length guard is the difference
   * between an answer and an absence of one.
   */
  if (rounds.length > 0 && rounds.every((r) => r.totalInWindow === 0)) {
    stoppedBecause = "no_changes";
  }

  log().info({
    event: "investigation_complete",
    orgId,
    rounds: rounds.length,
    stoppedBecause,
    confidence: conclusion?.confidence ?? 0,
  });

  return {
    incidentAt,
    rounds,
    conclusion,
    stoppedBecause,
    caveat: caveatFor(stoppedBecause, rounds),
  };
}

/**
 * Relevance, as explainable arithmetic rather than a model's opinion.
 *
 * Each signal contributes a stated amount and its reason is carried into the
 * report, so a human reading "this commit is the likely cause" can see exactly
 * why it rose — and disagree with it. A score with no visible derivation is
 * indistinguishable from a guess, which is precisely what this product exists
 * not to produce.
 */
export function rank(
  changes: ChangeRow[],
  pathsByChange: Map<number, string[]>,
  signals: Signals,
  incidentAt: Date,
): ScoredChange[] {
  const terms = usefulTerms(signals.terms);
  const hints = (signals.pathHints ?? []).map((h) => h.toLowerCase());

  const scored = changes.map((change): ScoredChange => {
    const paths = pathsByChange.get(change.id) ?? [];
    const why: string[] = [];
    let score = 0;

    const haystack = `${change.title}\n${change.body ?? ""}`.toLowerCase();
    const matchedTerms = terms.filter((term) => haystack.includes(term));
    if (matchedTerms.length > 0) {
      score += Math.min(0.45, 0.2 * matchedTerms.length);
      why.push(`mentions ${matchedTerms.join(", ")}`);
    }

    const matchedPaths = paths.filter((path) => {
      const lower = path.toLowerCase();
      return terms.some((t) => lower.includes(t)) || hints.some((h) => lower.includes(h));
    });
    if (matchedPaths.length > 0) {
      // Paths are stronger evidence than prose: a commit that edited the file
      // is a fact, whereas a commit that mentions it may only reference it.
      score += Math.min(0.5, 0.25 * matchedPaths.length);
      why.push(`touched ${matchedPaths.slice(0, 3).join(", ")}`);
    }

    /**
     * Proximity, as a gentle tiebreak only. Being close to the incident is
     * weak evidence — something has to be nearest — so it can order two
     * equally-matching changes but must never lift an unrelated one above a
     * matching one.
     */
    const hoursBefore = Math.max(
      0,
      (incidentAt.getTime() - change.occurredAt.getTime()) / 3_600_000,
    );
    const proximity = 0.15 * Math.exp(-hoursBefore / 24);
    score += proximity;
    if (proximity > 0.05) why.push("landed shortly before the incident");

    return { change, paths, score: Math.min(1, score), why };
  });

  return scored.sort(
    (a, b) =>
      b.score - a.score || b.change.occurredAt.getTime() - a.change.occurredAt.getTime(),
  );
}

function caveatFor(
  reason: Investigation["stoppedBecause"],
  rounds: Round[],
): string | null {
  const oldest = rounds.at(-1)?.window.from;
  switch (reason) {
    case "no_changes":
      return "No change was recorded in any window searched. Either nothing shipped in this period, or history has not been backfilled far enough — check the repository's coverage before concluding the cause is elsewhere.";
    case "lookback_limit":
      return `The search stopped at the lookback limit${oldest ? ` (${oldest.toISOString()})` : ""}. A cause older than that would not have been seen.`;
    case "scan_limit":
      return `More changes landed in this window than one pass scores, so only the ${SCAN_LIMIT} closest to the incident were examined. Narrow the window by recording a checkpoint nearer the incident, or name the affected repository.`;
    case "windows_exhausted":
      return "Every available checkpoint was searched without a confident match. The cause may predate the oldest checkpoint, or may not be a code change at all.";
    case "found":
      // Even a successful search has to admit it was capped. A saturated first
      // window that happens to score well returns a confident recommendation
      // over the newest slice of a window that may hold ten times as much.
      return rounds.some((r) => r.truncated)
        ? `A window held more changes than one pass scores, so only the ${SCAN_LIMIT} closest to the incident were examined. The match below is the best of those, not of everything that shipped.`
        : null;
  }
}

/**
 * A candidate as it leaves the API: flat, with the commit's own fields at the
 * top level rather than nested under `.change`.
 *
 * This type exists because the two used to differ. `summarize` returned the
 * internal `ScoredChange` while the rounds were flattened separately, so the
 * same concept had two shapes on one response and a client reading
 * `likelyCause.externalId` got `undefined` — but only when the search
 * succeeded, which is the one path nobody tests by accident.
 */
export interface RenderedCandidate {
  kind: string;
  externalId: string;
  title: string;
  url: string;
  author: string | null;
  occurredAt: Date;
  score: number;
  why: string[];
  paths: string[];
}

/** The single place a candidate becomes wire-shaped. */
export function renderCandidate(candidate: ScoredChange): RenderedCandidate {
  return {
    kind: candidate.change.kind,
    externalId: candidate.change.externalId,
    title: candidate.change.title,
    url: candidate.change.url,
    author: candidate.change.authorLogin,
    occurredAt: candidate.change.occurredAt,
    score: Number(candidate.score.toFixed(3)),
    why: candidate.why,
    paths: candidate.paths.slice(0, 5),
  };
}

/** The report shape the API and the agent both render. */
export function summarize(investigation: Investigation): {
  checkpoint: CheckpointRow | null;
  window: { from: string; to: string } | null;
  windowsSearched: number;
  likelyCause: RenderedCandidate | null;
  supporting: RenderedCandidate[];
  confidence: number;
  recommendation: string;
  caveat: string | null;
} {
  const round = investigation.conclusion;
  const top = round?.candidates[0] ?? null;

  return {
    checkpoint: round?.window.checkpoint ?? null,
    window: round
      ? {
          from: round.window.from.toISOString(),
          to: round.window.to.toISOString(),
        }
      : null,
    windowsSearched: investigation.rounds.length,
    likelyCause: top ? renderCandidate(top) : null,
    supporting: (round?.candidates.slice(1, 5) ?? []).map(renderCandidate),
    confidence: round?.confidence ?? 0,
    recommendation: recommend(top, investigation),
    caveat: investigation.caveat,
  };
}

/**
 * A next action, phrased as something to check rather than something proven.
 *
 * The score is a relevance ranking over commit text and file paths. It is
 * genuinely useful for narrowing a search and genuinely not proof of
 * causation, and the wording holds that line — a confident tone here would be
 * the exact failure this codebase refuses everywhere else.
 */
function recommend(top: ScoredChange | null, investigation: Investigation): string {
  if (!top) {
    return investigation.stoppedBecause === "no_changes"
      ? "Nothing shipped in the searched window, so look outside code: configuration, data, or an upstream provider."
      : "No change stood out. Widen the lookback, or record a checkpoint closer to when this was last known good so the next search starts nearer.";
  }

  const what = top.change.kind === "commit" ? "commit" : "pull request";
  return top.score >= 0.6
    ? `Start with ${what} ${top.change.externalId.slice(0, 12)} — ${top.why.join("; ")}. Confirm against the diff before reverting.`
    : `Weak match only. ${what} ${top.change.externalId.slice(0, 12)} is the closest candidate, but the evidence is thin — treat it as a lead, not a cause.`;
}
