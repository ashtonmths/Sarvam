import {
  changePaths,
  changes as changesTable,
  repoCursors,
  repositories,
} from "@sadhak/shared/schema";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db.js";
import type { RawChange, TouchedPath } from "./github-client.js";

/**
 * Persistence for the change log.
 *
 * Everything here is idempotent by construction. A webhook redelivery, a
 * backfill page that overlaps one already walked, and a retried job all have
 * to converge on the same rows — the unique key on (repo, kind, external id)
 * is what makes that true rather than hoped for.
 */

export interface ChangeRow {
  id: number;
  kind: "commit" | "pull_request";
  externalId: string;
  title: string;
  body: string | null;
  authorLogin: string | null;
  occurredAt: Date;
  url: string;
}

export async function upsertRepository(input: {
  orgId: number;
  owner: string;
  name: string;
  installationId?: number | null;
  defaultBranch?: string;
}): Promise<number> {
  const [row] = await db
    .insert(repositories)
    .values({
      orgId: input.orgId,
      owner: input.owner.toLowerCase(),
      name: input.name.toLowerCase(),
      installationId: input.installationId ?? null,
      defaultBranch: input.defaultBranch ?? "main",
    })
    .onConflictDoUpdate({
      target: [repositories.orgId, repositories.owner, repositories.name],
      set: {
        /**
         * Coalesced, so a caller that supplies no installation cannot clear
         * one. Re-linking still takes effect — a real installation id wins —
         * but the route that omitted it was silently un-linking repositories
         * the webhook path had already attached, downgrading them to the
         * deployment-wide token. Defending the column here means the next
         * caller cannot reintroduce that by forgetting.
         */
        installationId: sql`COALESCE(excluded.installation_id, ${repositories.installationId})`,
        defaultBranch: sql`excluded.default_branch`,
      },
    })
    .returning({ id: repositories.id });

  if (!row) throw new Error("failed to upsert repository");
  return row.id;
}

/**
 * Writes a page of changes and returns the ids that were newly inserted.
 *
 * The caller uses that to decide which changes still need their file paths
 * fetched — one API call each, so re-fetching them for rows that already
 * existed would triple the cost of an overlapping backfill for nothing.
 */
export async function saveChanges(
  orgId: number,
  repoId: number,
  incoming: RawChange[],
): Promise<Array<{ id: number; kind: string; externalId: string }>> {
  if (incoming.length === 0) return [];

  // A page can legitimately carry the same commit twice when a merge appears
  // under two parents; the unique index would reject the whole statement.
  const unique = new Map(incoming.map((c) => [`${c.kind}:${c.externalId}`, c]));

  const inserted = await db
    .insert(changesTable)
    .values(
      [...unique.values()].map((change) => ({
        orgId,
        repoId,
        kind: change.kind,
        externalId: change.externalId,
        title: change.title,
        body: change.body,
        authorLogin: change.authorLogin,
        authorEmail: change.authorEmail,
        occurredAt: change.occurredAt,
        url: change.url,
      })),
    )
    .onConflictDoNothing()
    .returning({
      id: changesTable.id,
      kind: changesTable.kind,
      externalId: changesTable.externalId,
    });

  return inserted;
}

export async function savePaths(changeId: number, paths: TouchedPath[]): Promise<void> {
  if (paths.length === 0) return;

  const unique = new Map(paths.map((p) => [p.path, p]));
  await db
    .insert(changePaths)
    .values(
      [...unique.values()].map((p) => ({
        changeId,
        path: p.path,
        status: p.status,
      })),
    )
    .onConflictDoNothing();
}

/* --------------------------------------------------------------- cursors */

export interface Cursor {
  backfilledTo: Date | null;
  caughtUpTo: Date | null;
  /** Index-paged walks resume here; timestamp-paged ones ignore it. */
  pagesWalked: number;
  /** Resume point of an in-flight forward drain. Null when none. */
  drainingTo: Date | null;
  complete: boolean;
}

export async function getCursor(
  repoId: number,
  kind: "commit" | "pull_request",
): Promise<Cursor> {
  const [row] = await db
    .select({
      backfilledTo: repoCursors.backfilledTo,
      caughtUpTo: repoCursors.caughtUpTo,
      pagesWalked: repoCursors.pagesWalked,
      drainingTo: repoCursors.drainingTo,
      complete: repoCursors.complete,
    })
    .from(repoCursors)
    .where(and(eq(repoCursors.repoId, repoId), eq(repoCursors.kind, kind)))
    .limit(1);

  return (
    row ?? {
      backfilledTo: null,
      caughtUpTo: null,
      pagesWalked: 0,
      drainingTo: null,
      complete: false,
    }
  );
}

/**
 * Committed after every page, which is the whole point of the table.
 *
 * The other paginated readers in this codebase hold their position in a local
 * variable, so a crash halfway through a large repository throws away all of
 * it. Here the next attempt resumes from the last page that actually landed.
 */
export async function saveCursor(
  repoId: number,
  kind: "commit" | "pull_request",
  update: Partial<Cursor>,
): Promise<void> {
  await db
    .insert(repoCursors)
    .values({
      repoId,
      kind,
      backfilledTo: update.backfilledTo ?? null,
      caughtUpTo: update.caughtUpTo ?? null,
      pagesWalked: update.pagesWalked ?? 0,
      drainingTo: update.drainingTo ?? null,
      complete: update.complete ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [repoCursors.repoId, repoCursors.kind],
      set: {
        // Only advance: a re-run that walks a narrower window must not report
        // less history than has genuinely been fetched.
        backfilledTo:
          update.backfilledTo === undefined
            ? sql`${repoCursors.backfilledTo}`
            : sql`LEAST(COALESCE(${repoCursors.backfilledTo}, excluded.backfilled_to), excluded.backfilled_to)`,
        caughtUpTo:
          update.caughtUpTo === undefined
            ? sql`${repoCursors.caughtUpTo}`
            : sql`GREATEST(COALESCE(${repoCursors.caughtUpTo}, excluded.caught_up_to), excluded.caught_up_to)`,
        /**
         * Set exactly as given, including back to null. Unlike the other two
         * this is not monotonic: it descends while a drain is in flight and is
         * cleared when the drain completes, so clamping it in either direction
         * would strand the resume point.
         */
        drainingTo:
          update.drainingTo === undefined
            ? sql`${repoCursors.drainingTo}`
            : sql`excluded.draining_to`,
        // Only forwards, like caughtUpTo: a re-run must never report less of
        // the list walked than has actually been read.
        pagesWalked:
          update.pagesWalked === undefined
            ? sql`${repoCursors.pagesWalked}`
            : sql`GREATEST(${repoCursors.pagesWalked}, excluded.pages_walked)`,
        complete:
          update.complete === undefined
            ? sql`${repoCursors.complete}`
            : sql`excluded.complete`,
        updatedAt: sql`now()`,
      },
    });
}

/* ----------------------------------------------------------------- reads */

/**
 * The primitive the whole investigation rests on: what changed in a window.
 *
 * Half-open on purpose — `[from, to)`. A checkpoint at exactly T means the
 * system was good *at* T, so the change that landed at T belongs to the window
 * that follows it, not the one it closes. Inclusive on both ends would put the
 * same change in two consecutive windows and let a widening search rediscover
 * what it already rejected.
 */
export async function changesBetween(
  orgId: number,
  window: { from: Date; to: Date; repoIds?: number[] },
  limit = 200,
): Promise<ChangeRow[]> {
  const scope = [
    eq(changesTable.orgId, orgId),
    gte(changesTable.occurredAt, window.from),
    lt(changesTable.occurredAt, window.to),
  ];
  if (window.repoIds && window.repoIds.length > 0) {
    scope.push(inArray(changesTable.repoId, window.repoIds));
  }

  return (
    db
      .select({
        id: changesTable.id,
        kind: changesTable.kind,
        externalId: changesTable.externalId,
        title: changesTable.title,
        body: changesTable.body,
        authorLogin: changesTable.authorLogin,
        occurredAt: changesTable.occurredAt,
        url: changesTable.url,
      })
      .from(changesTable)
      .where(and(...scope))
      // Newest first: the change most likely to have caused an incident is the
      // one closest to it, and a truncated list should keep those.
      .orderBy(desc(changesTable.occurredAt), desc(changesTable.id))
      .limit(limit)
  );
}

/** The touched paths for a set of changes, for relevance filtering. */
export async function pathsForChanges(
  changeIds: number[],
): Promise<Map<number, string[]>> {
  const byChange = new Map<number, string[]>();
  if (changeIds.length === 0) return byChange;

  const rows = await db
    .select({ changeId: changePaths.changeId, path: changePaths.path })
    .from(changePaths)
    .where(inArray(changePaths.changeId, changeIds))
    .orderBy(asc(changePaths.path));

  for (const row of rows) {
    const list = byChange.get(row.changeId);
    if (list) list.push(row.path);
    else byChange.set(row.changeId, [row.path]);
  }
  return byChange;
}

export async function listRepositories(orgId: number) {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.orgId, orgId))
    .orderBy(asc(repositories.owner), asc(repositories.name));
}

export async function findRepository(orgId: number, owner: string, name: string) {
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, orgId),
        eq(repositories.owner, owner.toLowerCase()),
        eq(repositories.name, name.toLowerCase()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** How much history exists, so the UI can say so rather than imply it. */
export async function coverageFor(repoId: number): Promise<{
  changes: number;
  earliest: Date | null;
  latest: Date | null;
}> {
  const [row] = await db
    .select({
      changes: sql<number>`count(*)::int`,
      earliest: sql<Date | null>`min(${changesTable.occurredAt})`,
      latest: sql<Date | null>`max(${changesTable.occurredAt})`,
    })
    .from(changesTable)
    .where(eq(changesTable.repoId, repoId));

  return row ?? { changes: 0, earliest: null, latest: null };
}
