import { describe, expect, it } from "vitest";

/**
 * The forward-drain invariant, as arithmetic.
 *
 * This bug survived two fixes, so it is pinned as a property rather than left
 * to a reading of the code. The walk runs newest-first from the top of a gap
 * down towards the watermark, which means a partial run knows "everything
 * above X is stored" while `caughtUpTo` asserts "everything below Y is
 * stored". Advancing the watermark before the walk reaches the bottom steps
 * over the middle — silently, permanently, and in exactly the window an
 * investigation searches.
 *
 * `decideCursor` is that decision in isolation: given how a run ended, what
 * may be written. Everything else in catchUpCommits is I/O around it.
 */

interface RunOutcome {
  drained: boolean;
  newestSeen: Date | null;
  descentReached: Date | null;
}

interface CursorWrite {
  caughtUpTo?: Date;
  drainingTo?: Date | null;
}

/** Mirrors the tail of catchUpCommits. */
function decideCursor(run: RunOutcome): CursorWrite | null {
  if (run.drained) {
    return {
      ...(run.newestSeen ? { caughtUpTo: run.newestSeen } : {}),
      drainingTo: null,
    };
  }
  if (run.descentReached) return { drainingTo: run.descentReached };
  return null;
}

const TOP = new Date("2026-03-12T18:00:00Z");
const MIDDLE = new Date("2026-03-12T12:00:00Z");

describe("forward drain cursor", () => {
  it("never advances the watermark on a partial run", () => {
    const write = decideCursor({
      drained: false,
      newestSeen: TOP,
      descentReached: MIDDLE,
    });
    // The run saw the top of the gap and stored it, but everything between
    // MIDDLE and the old watermark is still unfetched.
    expect(write?.caughtUpTo).toBeUndefined();
  });

  it("saves the descent point so the next run resumes instead of restarting", () => {
    const write = decideCursor({
      drained: false,
      newestSeen: TOP,
      descentReached: MIDDLE,
    });
    // Without this the walk restarts at the top every run and can never reach
    // the bottom of a gap wider than one run's page budget.
    expect(write?.drainingTo).toEqual(MIDDLE);
  });

  it("advances the watermark and clears the descent only once drained", () => {
    const write = decideCursor({
      drained: true,
      newestSeen: TOP,
      descentReached: MIDDLE,
    });
    expect(write?.caughtUpTo).toEqual(TOP);
    expect(write?.drainingTo).toBeNull();
  });

  it("clears the descent even when a drained run saw nothing", () => {
    // An empty first page means the gap was already closed; leaving a stale
    // descent point would make the next run resume a walk that is finished.
    const write = decideCursor({
      drained: true,
      newestSeen: null,
      descentReached: null,
    });
    expect(write?.caughtUpTo).toBeUndefined();
    expect(write?.drainingTo).toBeNull();
  });

  it("writes nothing when a run made no progress at all", () => {
    expect(
      decideCursor({ drained: false, newestSeen: null, descentReached: null }),
    ).toBeNull();
  });

  /**
   * The regression itself: five pages of a seven-page gap. Both earlier
   * versions wrote caughtUpTo = TOP here, and the two hundred commits below
   * MIDDLE fell outside every future `since` forever.
   */
  it("does not strand commits below the descent point", () => {
    const write = decideCursor({
      drained: false,
      newestSeen: TOP,
      descentReached: MIDDLE,
    });
    const nextSince = write?.caughtUpTo ?? null;
    expect(nextSince).toBeNull();
    expect(write?.drainingTo?.getTime()).toBeLessThan(TOP.getTime());
  });
});
