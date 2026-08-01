import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BlastRow, ChangeDescriptor } from "@sadhak/shared/types";
import { verdict as scoreVerdict } from "../sentinel/score.js";
import { blastRadius } from "../sentinel/verdict.js";

/**
 * "We replayed your own outages; here is what we would have caught."
 *
 * A different thing from `backtest.ts`, which replays stored verdicts through
 * the current kernel to prove determinism. This replays **incidents that
 * actually happened to a partner** — and, just as importantly, changes that
 * happened and broke nothing.
 *
 * The second half is what makes it honest. A report showing only catches is a
 * report anyone can produce by lowering the threshold until everything blocks.
 * The number that costs us something is the **false-alarm rate**: how often we
 * would have blocked a change that turned out to be fine. It is printed next to
 * the hit rate, at the same size, and a report generated without it is not a
 * report we send.
 *
 * ## Rules that keep it honest
 *
 * **Human-labeled only.** A fixture says what happened because a person who was
 * there said so. Auto-labeling from our own graph would ask the system to grade
 * its own homework.
 *
 * **Frozen at the labeling session.** The fixture set's hash goes in the report
 * header. A curated set is visible in its hash: rerun after quietly dropping
 * the inconvenient cases and the hash changes, and the old report still exists.
 *
 * **Never edited after generation.** If the numbers are bad, the conversation is
 * about the numbers.
 */

export interface LabeledIncident {
  /** What a human called it. */
  id: string;
  /**
   * The change that was made, in the shape the gate takes. Recorded exactly as
   * a caller would have sent it, so the replay asks the same question the gate
   * would have been asked at the time.
   */
  change: ChangeDescriptor;
  /** True if this change actually caused a problem. */
  brokeSomething: boolean;
  /** One line from the person who was there. Appears in the report. */
  whatHappened: string;
}

export interface IncidentFixtures {
  orgId: number;
  labeledAt: string;
  labeledBy: string;
  incidents: LabeledIncident[];
}

export interface IncidentBacktestReport {
  fixtureHash: string;
  labeledAt: string;
  labeledBy: string;
  /** Real incidents we would have flagged (BLOCK or WARN). */
  hits: { id: string; verdict: string; whatHappened: string }[];
  /** Real incidents we would have waved through. Each one explained. */
  misses: { id: string; verdict: string; whatHappened: string; why: string }[];
  /** Harmless changes we would have flagged. The number that costs us. */
  falseAlarms: { id: string; verdict: string; whatHappened: string }[];
  /** Harmless changes we would have let through, correctly. */
  correctlyQuiet: number;
  unresolvable: { id: string; why: string }[];
  hitRate: number | null;
  falseAlarmRate: number | null;
  note: string;
}

/** Same floor as the determinism backtest: a rate over four rows is not a rate. */
const SAMPLE_FLOOR = 5;

export function loadFixtures(path: string): IncidentFixtures {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as IncidentFixtures;
}

/** Hashes the canonical fixture content, so a quietly edited set is visible. */
export function fixtureHash(fixtures: IncidentFixtures): string {
  const canonical = JSON.stringify(
    fixtures.incidents
      .map((i) => ({
        id: i.id,
        change: i.change,
        brokeSomething: i.brokeSomething,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator >= SAMPLE_FLOOR
    ? Math.round((numerator / denominator) * 1000) / 1000
    : null;
}

/**
 * Replays each labeled change through the real kernel.
 *
 * The blast radius is computed against the graph **as it is now**, and that is
 * a stated limitation rather than a hidden one: a dependency added since the
 * incident makes us look better than we were, and one removed since makes us
 * look worse. It is the honest best available without a graph time machine, and
 * the report says so.
 */
export async function incidentBacktest(
  fixtures: IncidentFixtures,
): Promise<IncidentBacktestReport> {
  const hits: IncidentBacktestReport["hits"] = [];
  const misses: IncidentBacktestReport["misses"] = [];
  const falseAlarms: IncidentBacktestReport["falseAlarms"] = [];
  const unresolvable: IncidentBacktestReport["unresolvable"] = [];
  let correctlyQuiet = 0;

  for (const incident of fixtures.incidents) {
    let rows: BlastRow[];
    try {
      rows = await blastRadius(fixtures.orgId, incident.change);
    } catch (error) {
      // Usually the node no longer exists. Reported rather than dropped —
      // dropping the ones that will not replay is how a hit rate flatters.
      unresolvable.push({
        id: incident.id,
        why: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const { verdict } = scoreVerdict(rows);
    const flagged = verdict === "BLOCK" || verdict === "WARN";

    if (incident.brokeSomething && flagged) {
      hits.push({ id: incident.id, verdict, whatHappened: incident.whatHappened });
    } else if (incident.brokeSomething) {
      misses.push({
        id: incident.id,
        verdict,
        whatHappened: incident.whatHappened,
        // Every miss is explained, because "we missed some" with no reason is
        // the answer that ends the conversation.
        why:
          rows.length === 0
            ? "Nothing downstream was mapped, so the kernel saw an isolated node. Usually a connector that was not connected at the time."
            : `${rows.length} dependencies were found but none scored high enough to flag. The impact arithmetic is in the evidence chain.`,
      });
    } else if (flagged) {
      falseAlarms.push({ id: incident.id, verdict, whatHappened: incident.whatHappened });
    } else {
      correctlyQuiet++;
    }
  }

  const real = hits.length + misses.length;
  const harmless = falseAlarms.length + correctlyQuiet;

  return {
    fixtureHash: fixtureHash(fixtures),
    labeledAt: fixtures.labeledAt,
    labeledBy: fixtures.labeledBy,
    hits,
    misses,
    falseAlarms,
    correctlyQuiet,
    unresolvable,
    hitRate: rate(hits.length, real),
    falseAlarmRate: rate(falseAlarms.length, harmless),
    note: [
      real < SAMPLE_FLOOR
        ? `Fewer than ${SAMPLE_FLOOR} real incidents labeled, so the hit rate is withheld rather than quoted from a handful.`
        : null,
      harmless < SAMPLE_FLOOR
        ? `Fewer than ${SAMPLE_FLOOR} harmless changes labeled, so the false-alarm rate is withheld — and a hit rate without one is half a report.`
        : null,
      "Blast radius is computed against the graph as it is today, not as it was. A dependency added since flatters us; one removed since does the opposite.",
    ]
      .filter((line): line is string => line !== null)
      .join(" "),
  };
}

/** The report as text, for pasting into the conversation it exists to start. */
export function renderIncidentReport(report: IncidentBacktestReport): string {
  const pct = (value: number | null) =>
    value === null ? "withheld (too few labeled)" : `${Math.round(value * 100)}%`;

  return `Backtest against your own history
=================================
Fixtures  ${report.fixtureHash}  labeled ${report.labeledAt} by ${report.labeledBy}

  Caught          ${report.hits.length} of ${report.hits.length + report.misses.length} real incidents   ${pct(report.hitRate)}
  False alarms    ${report.falseAlarms.length} of ${report.falseAlarms.length + report.correctlyQuiet} harmless changes  ${pct(report.falseAlarmRate)}
${report.unresolvable.length > 0 ? `  Unreplayable    ${report.unresolvable.length} (node no longer exists)\n` : ""}
What we would have caught
${report.hits.map((h) => `  ${h.verdict.padEnd(7)} ${h.whatHappened}`).join("\n") || "  (none)"}

What we would have missed
${
  report.misses
    .map((m) => `  ${m.verdict.padEnd(7)} ${m.whatHappened}\n          why: ${m.why}`)
    .join("\n") || "  (none)"
}

What we would have flagged that was fine
${report.falseAlarms.map((f) => `  ${f.verdict.padEnd(7)} ${f.whatHappened}`).join("\n") || "  (none)"}

${report.note}
`;
}
