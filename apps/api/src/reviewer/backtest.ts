import type { BlastRow, Evidence } from "@sadhak/shared/types";
import { sql } from "../db.js";
import { verdict as scoreVerdict } from "../sentinel/score.js";

/**
 * The backtest: replay decisions the gate already made through today's kernel
 * and report where the two disagree.
 *
 * This is what would ground `incidentsAvoidedModelled`, and it is also the only
 * honest way to change a threshold. Moving `BLOCK_IMPACT` is a claim that the
 * new value would have judged history better; a backtest is that claim checked
 * instead of asserted.
 *
 * Two things it deliberately is not:
 *
 * **Not a hit rate against outcomes.** We do not know which changes would have
 * broken something, only which ones we blocked. Reporting "94% accurate" would
 * be inventing a ground truth nobody has. What is knowable is agreement between
 * the stored verdict and the recomputed one, and where they differ.
 *
 * **Not a source of a headline number yet.** With no disagreements and few
 * rows, the only honest output is "insufficient history", which this returns
 * rather than a confident 100%.
 */

/** Below this, agreement is arithmetic on a handful of rows, not a signal. */
const MIN_SAMPLE = 30;

export interface Divergence {
  verdictId: string;
  storedVerdict: string;
  recomputedVerdict: string;
  createdAt: string;
}

export interface BacktestReport {
  /** Verdicts with a stored blast radius to replay. */
  replayed: number;
  agreed: number;
  divergences: Divergence[];
  /**
   * Null below the sample floor. A rate over four rows is a number people
   * quote and nobody can defend.
   */
  agreementRate: number | null;
  /** Says plainly why a rate is absent, so absence is not read as failure. */
  note: string;
}

interface StoredVerdict {
  id: string;
  verdict: string;
  impacted: BlastRow[] | null;
  created_at: string;
}

/**
 * Replays every stored verdict for an org through the current kernel.
 *
 * Only the scoring kernel is re-run, not the traversal: the graph has moved on
 * since those decisions, so re-traversing would compare today's dependencies
 * against yesterday's verdict and call the difference a regression. The stored
 * `impacted` rows are the blast radius as it was, which is exactly the input
 * the kernel took at the time.
 */
export async function backtest(orgId: number): Promise<BacktestReport> {
  const rows = await sql<StoredVerdict[]>`
    SELECT id, verdict, impacted, created_at
    FROM verdicts
    WHERE org_id = ${orgId}
      AND jsonb_array_length(coalesce(impacted, '[]'::jsonb)) >= 0
    ORDER BY created_at
  `;

  const divergences: Divergence[] = [];
  let replayed = 0;
  let agreed = 0;

  for (const row of rows) {
    const impacted = row.impacted ?? [];
    replayed += 1;

    const recomputed: { verdict: string; evidence: Evidence[] } = scoreVerdict(impacted);

    if (recomputed.verdict === row.verdict) {
      agreed += 1;
    } else {
      divergences.push({
        verdictId: row.id,
        storedVerdict: row.verdict,
        recomputedVerdict: recomputed.verdict,
        createdAt: row.created_at,
      });
    }
  }

  const enough = replayed >= MIN_SAMPLE;

  return {
    replayed,
    agreed,
    divergences,
    agreementRate: enough ? agreed / replayed : null,
    note: enough
      ? divergences.length === 0
        ? `Every one of ${replayed} stored verdicts reproduces under the current kernel.`
        : `${divergences.length} of ${replayed} stored verdicts would be judged differently today. Each one is either a scoring change nobody wrote down, or a bug.`
      : `Only ${replayed} verdicts to replay; ${MIN_SAMPLE} is the floor for a rate worth quoting. Agreement so far: ${agreed}/${replayed}.`,
  };
}
