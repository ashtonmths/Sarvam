import type { Repository } from "@sadhak/shared/schema";
import { log } from "../log.js";
import {
  fetchCommits,
  fetchPaths,
  fetchPulls,
  type RawChange,
  tokenForRepo,
} from "./github-client.js";
import { getCursor, saveChanges, saveCursor, savePaths } from "./store.js";

/**
 * Walks a repository's history, committing its position as it goes.
 *
 * Bounded per run rather than looping to completion. A repository with ten
 * years of commits would otherwise hold a worker for as long as it took and
 * burn the whole hourly rate limit in one go; instead each run takes a few
 * pages, saves where it reached, and the job re-enqueues itself.
 *
 * Two directions, and both matter. Backwards fills history so an old incident
 * can be investigated at all; forwards keeps the store current so a *new* one
 * can be. A gap in either is invisible afterwards — the search still runs,
 * still reports confidence, and simply does not contain the cause.
 */

/** Pages per run, per direction. Keeps one repository off a whole rate limit. */
const PAGES_PER_RUN = 5;

const PER_PAGE = 100;

/**
 * A clock bound on vendor timestamps.
 *
 * Commit dates are attacker- and accident-controlled: `GIT_AUTHOR_DATE`, a
 * laptop with a wrong clock, a botched rebase. The watermark is deliberately
 * monotonic, so a single commit dated 2030 would advance it past every real
 * commit and freeze the repository forever with no error and no log line.
 * Anything claiming to be from the future is clamped to now instead.
 */
function sane(at: Date): Date {
  const now = Date.now();
  return at.getTime() > now ? new Date(now) : at;
}

export interface BackfillResult {
  fetched: number;
  stored: number;
  pathsFetched: number;
  reachedEnd: boolean;
  /**
   * The run read pages and stored nothing new, so it cannot advance.
   *
   * Happens when more commits share one instant than a page holds. The walk
   * correctly refuses to step over them, but without saying so the job would
   * reschedule on the fast interval and re-read the same two pages every
   * thirty seconds indefinitely.
   */
  stuck: boolean;
  oldest: Date | null;
}

function empty(reachedEnd: boolean, oldest: Date | null = null): BackfillResult {
  return { fetched: 0, stored: 0, pathsFetched: 0, reachedEnd, stuck: false, oldest };
}

/* --------------------------------------------------------------- forwards */

/**
 * Fetches everything that landed since the last pass, oldest gap first.
 *
 * Paginated, which the first version was not: it took one page of 100 and then
 * advanced the watermark past everything it had not read. A repository landing
 * more than 100 commits between polls — a release train, a merge queue, a bulk
 * dependency bump — silently lost the middle of the exact window an
 * investigation searches, and nothing downstream could tell.
 *
 * Walks by narrowing `until` from the newest downwards, so each page is a
 * bounded query rather than an offset into a list that shifts under it. The
 * watermark advances only once the gap is fully drained.
 */
export async function catchUpCommits(
  repo: Repository,
  signal?: AbortSignal,
): Promise<BackfillResult> {
  const cursor = await getCursor(repo.id, "commit");
  // No watermark yet: the backwards walk is about to cover this ground anyway.
  if (!cursor.caughtUpTo) return empty(true);

  const token = await tokenForRepo(repo);
  const since = new Date(cursor.caughtUpTo.getTime() + 1);
  const result = empty(true);

  let newest: Date | null = null;
  // Resume a drain that ran out of budget last time rather than restarting at
  // the top, which would re-walk the same pages forever and never reach the
  // bottom of a gap wider than one run.
  let until: Date | undefined = cursor.drainingTo ?? undefined;
  let drained = false;

  for (let page = 0; page < PAGES_PER_RUN; page += 1) {
    const { changes } = await fetchCommits(
      repo,
      token,
      until ? { since, until } : { since },
      PER_PAGE,
      signal,
    );

    // Nothing left between the watermark and the descent point.
    if (changes.length === 0) {
      drained = true;
      break;
    }

    result.fetched += changes.length;
    const stored = await persist(repo, token, changes, result, signal);
    result.stored += stored;

    const pageNewest = sane(newestOf(changes));
    if (!newest || pageNewest > newest) newest = pageNewest;

    const pageOldest = oldestOf(changes);
    // Reached the watermark: everything in the gap is now stored.
    if (pageOldest <= since) {
      drained = true;
      break;
    }

    const stalled = until !== undefined && pageOldest.getTime() === until.getTime();
    // Inclusive, so a commit sharing this instant is re-requested rather than
    // skipped. Duplicates are absorbed by the unique key; a skip is forever.
    until = pageOldest;

    /**
     * More than a page of commits share one second, so the bound cannot move.
     * Stopping is the only option that neither loops forever nor skips the
     * rest of that second — and because the watermark is not advanced below,
     * the next run resumes here rather than losing them.
     */
    if (stalled && stored === 0) break;
  }

  /**
   * The watermark advances only when the gap actually closed.
   *
   * This is the bug the first two versions had, in two forms: the original
   * fetched one page and jumped the watermark past everything it had not read,
   * and the paginated rewrite did the same thing five pages later. The walk
   * runs newest-first, so a partial run holds "everything above X" while
   * `caughtUpTo` means "everything below Y" — advancing it mid-drain steps
   * over the part not yet fetched, permanently and silently.
   *
   * A partial run therefore saves only its descent point. `caughtUpTo` moves
   * to this run's newest, which after a resumed drain is below the true top —
   * so the following run re-reads a little and stores nothing new, which costs
   * one list call and cannot lose anything.
   */
  if (drained) {
    await saveCursor(repo.id, "commit", {
      ...(newest ? { caughtUpTo: newest } : {}),
      drainingTo: null,
    });
  } else if (until) {
    result.reachedEnd = false;
    await saveCursor(repo.id, "commit", { drainingTo: until });
  }

  if (result.fetched > 0) {
    log().info({
      event: "github_caught_up",
      repo: `${repo.owner}/${repo.name}`,
      fetched: result.fetched,
      stored: result.stored,
    });
  }

  return result;
}

/* -------------------------------------------------------------- backwards */

export async function backfillCommits(
  repo: Repository,
  signal?: AbortSignal,
): Promise<BackfillResult> {
  const cursor = await getCursor(repo.id, "commit");
  if (cursor.complete) return empty(true, cursor.backfilledTo);

  const token = await tokenForRepo(repo);
  const result = empty(false, cursor.backfilledTo);
  let until = cursor.backfilledTo ?? undefined;

  for (let page = 0; page < PAGES_PER_RUN; page += 1) {
    const { changes, hasMore } = await fetchCommits(
      repo,
      token,
      until ? { until } : {},
      PER_PAGE,
      signal,
    );

    if (changes.length === 0) {
      await saveCursor(repo.id, "commit", { complete: true });
      result.reachedEnd = true;
      break;
    }

    result.fetched += changes.length;
    const stored = await persist(repo, token, changes, result, signal);
    result.stored += stored;

    const oldest = boundFrom(changes);
    result.oldest = oldest;

    /**
     * One save per page, before any exit.
     *
     * The completion break used to come first, so a repository whose whole
     * history fits in one page — every new service, and every repository a
     * demo starts with — took the `!hasMore` path on page 0 and never reached
     * the seed below it. `caughtUpTo` stayed null, which makes `catchUpCommits`
     * return immediately forever, so the commit log froze at the moment the
     * repository was added while `GET /repos` reported it complete. The freeze
     * this file keeps trying to eliminate, relocated onto small repositories.
     *
     * `complete` is withheld when the page stored nothing: a genuine
     * end-of-history page carries new rows, whereas a page of pure duplicates
     * means the walk is stuck, and latching `complete` there would make the
     * stall permanent and invisible.
     */
    const finished = !hasMore && stored > 0;
    await saveCursor(repo.id, "commit", {
      backfilledTo: oldest,
      ...(cursor.caughtUpTo ? {} : { caughtUpTo: sane(newestOf(changes)) }),
      ...(finished ? { complete: true } : {}),
    });

    /**
     * The bound stays *inclusive* of the oldest instant seen.
     *
     * Subtracting a millisecond looked like the way to guarantee progress, and
     * it does — by skipping every commit that shares the oldest commit's
     * second but fell on the far side of the page boundary. Timestamps here
     * are second-precision, so that boundary lands mid-second routinely, and
     * the loss is silent and permanent. Re-requesting the overlap costs one
     * duplicate page; the unique key absorbs it.
     */
    until = oldest;

    if (finished) {
      result.reachedEnd = true;
      break;
    }

    // Progress is proven by new rows, not by arithmetic. A page that stored
    // nothing and cannot move the bound is a genuine stall — more than a
    // page of commits sharing one second — and looping would never end.
    if (stored === 0 && page > 0) break;
  }

  result.stuck = result.fetched > 0 && result.stored === 0 && !result.reachedEnd;

  const line = {
    event: "github_backfill_page",
    repo: `${repo.owner}/${repo.name}`,
    fetched: result.fetched,
    stored: result.stored,
    reachedEnd: result.reachedEnd,
  };
  if (result.stuck) {
    // Worth a warning rather than an info line: the walk has stopped making
    // progress and no amount of retrying will change that on its own.
    log().warn({
      ...line,
      stuckAt: result.oldest,
      msg: "backfill cannot advance past this instant; more commits share it than a page holds",
    });
  } else {
    log().info(line);
  }

  return result;
}

/* ------------------------------------------------------------------ pulls */

/**
 * Pull requests, walked by page index which is persisted between runs.
 *
 * GitHub's pull list has no `until` to narrow, so this pages by index — and
 * the index has to survive the run or the walk restarts at page one every
 * time, which is exactly what it did: five pages every thirty seconds forever,
 * re-reading the same five hundred pull requests and never reaching the five
 * hundred and first.
 */
export async function backfillPulls(
  repo: Repository,
  signal?: AbortSignal,
): Promise<BackfillResult> {
  const cursor = await getCursor(repo.id, "pull_request");
  if (cursor.complete) return empty(true, cursor.backfilledTo);

  const token = await tokenForRepo(repo);
  const result = empty(false, cursor.backfilledTo);
  const startPage = cursor.pagesWalked;

  for (let offset = 0; offset < PAGES_PER_RUN; offset += 1) {
    const page = startPage + offset + 1;
    const { changes, hasMore } = await fetchPulls(repo, token, page, PER_PAGE, signal);

    if (changes.length === 0) {
      await saveCursor(repo.id, "pull_request", { complete: true });
      result.reachedEnd = true;
      break;
    }

    result.fetched += changes.length;
    result.stored += await persist(repo, token, changes, result, signal);

    await saveCursor(repo.id, "pull_request", { pagesWalked: page });

    if (!hasMore) {
      await saveCursor(repo.id, "pull_request", { complete: true });
      result.reachedEnd = true;
      break;
    }
  }

  return result;
}

/**
 * Re-reads the first page of pull requests, which is where new and newly
 * merged ones appear under `sort=updated`.
 *
 * Without this a repository with fewer than five hundred pull requests
 * finishes its walk, sets `complete`, and never records another one — the same
 * freeze the commit path had, hitting small repositories hardest because they
 * finish fastest.
 */
export async function catchUpPulls(
  repo: Repository,
  signal?: AbortSignal,
): Promise<BackfillResult> {
  const token = await tokenForRepo(repo);
  const result = empty(true);

  const { changes } = await fetchPulls(repo, token, 1, PER_PAGE, signal);
  if (changes.length === 0) return result;

  result.fetched = changes.length;
  result.stored = await persist(repo, token, changes, result, signal);
  return result;
}

/* ---------------------------------------------------------------- shared */

/**
 * Stores a page, then fetches paths only for what was newly inserted.
 *
 * Paths cost one API call each, so re-fetching them for rows an overlapping
 * page already covered would be the most expensive mistake available here —
 * and overlap is now deliberate, since the bounds are inclusive.
 */
async function persist(
  repo: Repository,
  token: string,
  changes: RawChange[],
  result: BackfillResult,
  signal?: AbortSignal,
): Promise<number> {
  const inserted = await saveChanges(repo.orgId, repo.id, changes);

  for (const row of inserted) {
    try {
      const paths = await fetchPaths(
        repo,
        token,
        { kind: row.kind as "commit" | "pull_request", externalId: row.externalId },
        signal,
      );
      await savePaths(row.id, paths);
      result.pathsFetched += paths.length;
    } catch (error) {
      log().warn({
        event: "github_paths_failed",
        repo: `${repo.owner}/${repo.name}`,
        externalId: row.externalId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return inserted.length;
}

/**
 * Nothing in git predates this, so a commit claiming to is a broken clock.
 *
 * Epoch-zero and 1970-ish dates are real artifacts of CVS and Subversion
 * imports and of `filter-branch`, and GitHub's commit list is ordered by graph
 * traversal rather than strictly by date, so one can surface in the middle of
 * a page.
 */
const GIT_EPOCH = new Date("1995-01-01T00:00:00Z");

/**
 * The descent bound for a page, ignoring implausibly old outliers.
 *
 * Taking a plain minimum let a single 1970-dated commit capture the bound:
 * `until` jumped to 1970, the next page returned only that commit, and the
 * walk finished having skipped everything in between — permanently, because
 * `backfilledTo` only moves backwards and `complete` latches.
 *
 * The outlier is still *stored*; it is only excluded from deciding where the
 * walk goes next. If a page holds nothing but outliers the minimum stands,
 * since some bound is needed and the stall check will stop the walk.
 */
function boundFrom(changes: RawChange[]): Date {
  const plausible = changes.filter((c) => c.occurredAt >= GIT_EPOCH);
  return oldestOf(plausible.length > 0 ? plausible : changes);
}

function oldestOf(changes: RawChange[]): Date {
  return changes.reduce(
    (min, c) => (c.occurredAt < min ? c.occurredAt : min),
    changes[0]?.occurredAt ?? new Date(),
  );
}

function newestOf(changes: RawChange[]): Date {
  return changes.reduce(
    (max, c) => (c.occurredAt > max ? c.occurredAt : max),
    changes[0]?.occurredAt ?? new Date(),
  );
}
