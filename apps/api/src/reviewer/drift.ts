import { driftFindings, structuralHashes } from "@sadhak/shared/schema";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import { log } from "../log.js";
import { driftFindingsOpened, driftTicks } from "../metrics.js";
import { diffScopes, rootHash, signatureFor } from "./hash.js";

/**
 * The drift gate: deterministic, and deliberately model-free.
 *
 * Two properties this rests on, both load-bearing:
 *
 * 1. **A quiet tick costs one comparison.** Roughly 99% of ticks find nothing,
 *    and those must cost a root-hash compare and no more — no per-entity
 *    writes, no crawl, no model request.
 *
 * 2. **Detection survives an exhausted model quota.** Nothing here calls
 *    `llm.ts`. On a day when the daily request cap is spent, findings keep
 *    opening and hashes keep advancing; only *investigation* defers. A drift
 *    detector that goes blind when the quota runs out is a drift detector that
 *    goes blind exactly when a busy day made it matter.
 */

/** How long a judged dismissal keeps muting the same signature. */
const SUPPRESSION_DAYS = 30;

export interface EntityScope {
  /** 'workflow/17', 'base/appX', 'db/demo_billing'. */
  scope: string;
  /** Canonical hash of this entity's live structure. */
  hash: string;
  /** Live structure, snapshotted onto the finding when this scope changed. */
  live?: Record<string, unknown>;
}

export interface TickResult {
  changed: boolean;
  shortCircuited: boolean;
  findingsOpened: number;
  findingsAutoDismissed: number;
  /** Ids of the findings this tick opened, for the caller to queue triage on. */
  openedIds: number[];
  scopes: { added: string[]; removed: string[]; changed: string[] };
}

/**
 * One tick for one connector instance.
 *
 * The caller supplies live entity hashes, having fetched them through the
 * read-only connector clients — so the URL allowlists still apply and a tick
 * can never reach a payload endpoint.
 */
export async function tick(input: {
  orgId: number;
  connectorInstanceId: number;
  entities: EntityScope[];
}): Promise<TickResult> {
  const { orgId, connectorInstanceId } = input;
  const live = new Map(input.entities.map((e) => [e.scope, e.hash]));
  const liveRoot = rootHash(live);

  driftTicks.inc({ outcome: "started" });

  const storedRoot = await hashFor(orgId, connectorInstanceId, "root");

  // The short circuit. Touch `computed_at` so a quiet instance is still
  // visibly being checked, and stop before reading a single entity row.
  if (storedRoot === liveRoot) {
    await touchRoot(orgId, connectorInstanceId);
    driftTicks.inc({ outcome: "short_circuited" });
    return {
      changed: false,
      shortCircuited: true,
      findingsOpened: 0,
      findingsAutoDismissed: 0,
      openedIds: [],
      scopes: { added: [], removed: [], changed: [] },
    };
  }

  const documented = await entityHashes(orgId, connectorInstanceId);
  const scopes = diffScopes(documented, live);

  // First tick for an instance: record the baseline rather than opening a
  // finding for every entity that has always existed.
  const isFirstRun = storedRoot === null && documented.size === 0;

  const openedIds: number[] = [];
  let autoDismissed = 0;

  if (!isFirstRun) {
    const touched = [...scopes.changed, ...scopes.added, ...scopes.removed];
    for (const scope of touched) {
      const shape = scopes.changed.includes(scope)
        ? "changed"
        : scopes.added.includes(scope)
          ? "added"
          : "removed";

      const result = await openFinding({
        orgId,
        connectorInstanceId,
        scope,
        shape,
        documentedState: { hash: documented.get(scope) ?? null },
        liveState: {
          hash: live.get(scope) ?? null,
          ...(input.entities.find((e) => e.scope === scope)?.live ?? {}),
        },
      });

      if (typeof result === "number") openedIds.push(result);
      else if (result === "auto_dismissed") autoDismissed += 1;
    }
  }

  await writeHashes(orgId, connectorInstanceId, live, liveRoot);

  log().info({
    event: "drift_tick",
    connectorInstanceId,
    changed: true,
    firstRun: isFirstRun,
    added: scopes.added.length,
    removed: scopes.removed.length,
    changedScopes: scopes.changed.length,
    findingsOpened: openedIds.length,
    findingsAutoDismissed: autoDismissed,
  });

  return {
    changed: true,
    shortCircuited: false,
    findingsOpened: openedIds.length,
    findingsAutoDismissed: autoDismissed,
    openedIds,
    scopes,
  };
}

/** The new finding's id when one was opened, or why it was not. */
type OpenOutcome = number | "auto_dismissed" | "already_open";

/**
 * Opens a finding unless this signature was *judged* benign recently, or an
 * identical finding is already waiting.
 *
 * The suppression lookup is scoped to judgments on purpose. A run that ended
 * on a step or token limit never writes a dismissal, so an investigation that
 * never finished cannot mute the signature it failed to reach a verdict on.
 */
async function openFinding(input: {
  orgId: number;
  connectorInstanceId: number;
  scope: string;
  shape: string;
  documentedState: Record<string, unknown>;
  liveState: Record<string, unknown>;
}): Promise<OpenOutcome> {
  const signature = signatureFor({
    connectorInstanceId: input.connectorInstanceId,
    scope: input.scope,
    kind: "hash_change",
    shape: input.shape,
  });

  const suppressedSince = new Date(Date.now() - SUPPRESSION_DAYS * 86_400_000);

  const [priorJudgment] = await db
    .select({ id: driftFindings.id })
    .from(driftFindings)
    .where(
      and(
        eq(driftFindings.orgId, input.orgId),
        eq(driftFindings.signature, signature),
        eq(driftFindings.state, "dismissed"),
        // A dismissal is only a judgment if a reason was recorded.
        sql`${driftFindings.dismissReason} IS NOT NULL`,
        /**
         * And only a *human* judgment mutes. The triage agent's prompt
         * carries table and column names taken from a customer's systems, so
         * a hostile field name is an attempt to steer it; letting an agent
         * dismissal suppress would turn that into 30 days of silence on a
         * real breakage. Out-of-model by construction: this holds however
         * thoroughly the model was fooled, and survives swapping it for a
         * weaker one.
         */
        sql`${driftFindings.dismissedBy} IS DISTINCT FROM 'reviewer'`,
        gt(driftFindings.resolvedAt, suppressedSince),
      ),
    )
    .limit(1);

  const state = priorJudgment ? "auto_dismissed" : "open";

  // An unreviewed finding for the same signature already covers this.
  if (state === "open") {
    const [pending] = await db
      .select({ id: driftFindings.id })
      .from(driftFindings)
      .where(
        and(
          eq(driftFindings.orgId, input.orgId),
          eq(driftFindings.signature, signature),
          inArray(driftFindings.state, ["open", "investigating"]),
        ),
      )
      .limit(1);
    if (pending) return "already_open";
  }

  const [inserted] = await db
    .insert(driftFindings)
    .values({
      orgId: input.orgId,
      connectorInstanceId: input.connectorInstanceId,
      kind: "hash_change",
      scope: input.scope,
      signature,
      documentedState: input.documentedState,
      liveState: input.liveState,
      state,
      ...(state === "auto_dismissed" ? { resolvedAt: new Date() } : {}),
    })
    .returning({ id: driftFindings.id });

  driftFindingsOpened.inc({ outcome: state });
  if (state === "auto_dismissed") return "auto_dismissed";
  return inserted?.id ?? "already_open";
}

/* ------------------------------------------------------------- storage */

async function hashFor(
  orgId: number,
  connectorInstanceId: number,
  scope: string,
): Promise<string | null> {
  const [row] = await db
    .select({ hash: structuralHashes.hash })
    .from(structuralHashes)
    .where(
      and(
        eq(structuralHashes.orgId, orgId),
        eq(structuralHashes.connectorInstanceId, connectorInstanceId),
        eq(structuralHashes.scope, scope),
      ),
    )
    .limit(1);
  return row?.hash ?? null;
}

async function entityHashes(
  orgId: number,
  connectorInstanceId: number,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ scope: structuralHashes.scope, hash: structuralHashes.hash })
    .from(structuralHashes)
    .where(
      and(
        eq(structuralHashes.orgId, orgId),
        eq(structuralHashes.connectorInstanceId, connectorInstanceId),
      ),
    );
  return new Map(rows.filter((r) => r.scope !== "root").map((r) => [r.scope, r.hash]));
}

async function touchRoot(orgId: number, connectorInstanceId: number): Promise<void> {
  await db
    .update(structuralHashes)
    .set({ computedAt: new Date() })
    .where(
      and(
        eq(structuralHashes.orgId, orgId),
        eq(structuralHashes.connectorInstanceId, connectorInstanceId),
        eq(structuralHashes.scope, "root"),
      ),
    );
}

/**
 * Replaces the recorded structure for this instance. Deleting scopes that no
 * longer exist is what stops a removed entity being re-reported on every
 * subsequent tick.
 */
async function writeHashes(
  orgId: number,
  connectorInstanceId: number,
  live: ReadonlyMap<string, string>,
  liveRoot: string,
): Promise<void> {
  const rows = [
    { scope: "root", hash: liveRoot },
    ...[...live.entries()].map(([scope, hash]) => ({ scope, hash })),
  ];

  await db.transaction(async (tx) => {
    await tx
      .delete(structuralHashes)
      .where(
        and(
          eq(structuralHashes.orgId, orgId),
          eq(structuralHashes.connectorInstanceId, connectorInstanceId),
        ),
      );
    await tx.insert(structuralHashes).values(
      rows.map((row) => ({
        orgId,
        connectorInstanceId,
        scope: row.scope,
        hash: row.hash,
        computedAt: new Date(),
      })),
    );
  });
}
