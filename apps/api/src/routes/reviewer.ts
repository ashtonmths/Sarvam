import {
  connectorInstances,
  driftFindings,
  structuralHashes,
} from "@sadhak/shared/schema";
import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { parsePagination } from "../http/pagination.js";
import { requireCapability } from "../middleware/auth.js";
import { backtest } from "../reviewer/backtest.js";
import { computeMetrics } from "../reviewer/metrics.js";

export const reviewerRoutes = new Hono();

/**
 * The correction queue.
 *
 * A finding is a claim that the map and the live system disagree. Resolving
 * one is a judgment, and the judgment is the product: it is what earns the
 * suppression that stops the same benign change waking anyone again, and it is
 * the thing a competitor cannot crawl.
 */
reviewerRoutes.get("/drift/findings", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const { limit, cursor } = parsePagination(c.req.query());

  // Default hides the noise the gate already judged: an operator opening this
  // page wants what needs deciding, not a log of what did not.
  const stateFilter = c.req.query("state");
  const states = stateFilter ? [stateFilter] : (["open", "investigating"] as string[]);

  const rows = await db
    .select({
      id: driftFindings.id,
      kind: driftFindings.kind,
      scope: driftFindings.scope,
      state: driftFindings.state,
      signature: driftFindings.signature,
      documentedState: driftFindings.documentedState,
      liveState: driftFindings.liveState,
      dismissReason: driftFindings.dismissReason,
      budgetExhaustedAt: driftFindings.budgetExhaustedAt,
      runId: driftFindings.runId,
      createdAt: driftFindings.createdAt,
      resolvedAt: driftFindings.resolvedAt,
      connectorInstanceId: driftFindings.connectorInstanceId,
      connector: connectorInstances.connector,
      instanceName: connectorInstances.displayName,
    })
    .from(driftFindings)
    .innerJoin(
      connectorInstances,
      eq(connectorInstances.id, driftFindings.connectorInstanceId),
    )
    .where(
      and(
        eq(driftFindings.orgId, orgId),
        inArray(driftFindings.state, states as never),
        ...(cursor ? [lt(driftFindings.id, Number(cursor))] : []),
      ),
    )
    .orderBy(desc(driftFindings.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return c.json({
    items: page,
    nextCursor: rows.length > limit ? String(page.at(-1)?.id) : null,
  });
});

/**
 * How much of the map is currently disputed, and how quiet the gate is.
 *
 * The short-circuit ratio is a product claim (~99% of ticks cost nothing) and
 * a quota-feasibility claim, so it is reported rather than asserted.
 */
reviewerRoutes.get("/drift/summary", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");

  const byState = await db
    .select({ state: driftFindings.state, n: count() })
    .from(driftFindings)
    .where(eq(driftFindings.orgId, orgId))
    .groupBy(driftFindings.state);

  const [watched] = await db
    .select({ n: count() })
    .from(structuralHashes)
    .where(and(eq(structuralHashes.orgId, orgId), eq(structuralHashes.scope, "root")));

  const [lastChecked] = await db
    .select({ at: sql<string>`max(${structuralHashes.computedAt})` })
    .from(structuralHashes)
    .where(eq(structuralHashes.orgId, orgId));

  const counts = Object.fromEntries(byState.map((row) => [row.state, row.n]));

  return c.json({
    open: counts.open ?? 0,
    investigating: counts.investigating ?? 0,
    corrected: counts.corrected ?? 0,
    dismissed: counts.dismissed ?? 0,
    autoDismissed: counts.auto_dismissed ?? 0,
    instancesWatched: watched?.n ?? 0,
    lastCheckedAt: lastChecked?.at ?? null,
  });
});

/**
 * The metrics summary. Observable facts only — no counterfactual, no blended
 * MTTD, and coverage always as two numbers.
 */
reviewerRoutes.get("/metrics/summary", requireCapability("graph:read"), async (c) => {
  return c.json(await computeMetrics(c.get("orgId")));
});

/**
 * Replays stored decisions through today's kernel. Read-only, and reports no
 * rate below its sample floor rather than a flattering one.
 */
reviewerRoutes.get("/metrics/backtest", requireCapability("graph:read"), async (c) => {
  return c.json(await backtest(c.get("orgId")));
});

const resolvable = ["open", "investigating"] as const;

/**
 * Dismissing is the judgment that earns suppression, so a reason is required
 * rather than optional. A dismissal with no reason cannot be distinguished
 * later from a run that gave up, and the whole suppression rule turns on that
 * distinction.
 */
reviewerRoutes.post(
  "/drift/findings/:id/dismiss",
  requireCapability("rationale:confirm"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const actor = c.get("actor");
    const actorLabel = actor.type === "user" ? actor.email : `api_key:${actor.id}`;
    const body = z
      .object({ reason: z.string().min(3).max(500) })
      .parse(await c.req.json().catch(() => ({})));

    const updated = await db
      .update(driftFindings)
      .set({
        state: "dismissed",
        dismissReason: body.reason,
        // A human judgment, and therefore one that earns suppression.
        dismissedBy: actorLabel,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(driftFindings.id, id),
          eq(driftFindings.orgId, orgId),
          inArray(driftFindings.state, resolvable as never),
        ),
      )
      .returning({ id: driftFindings.id, signature: driftFindings.signature });

    if (updated.length === 0) await explainWhyNot(orgId, id);

    await audit(c, "drift.dismissed", { kind: "drift_finding", id });
    return c.json({ ok: true, suppressesSignature: updated[0]?.signature ?? null });
  },
);

/**
 * Marking corrected says the map has been brought back in step — by a crawl,
 * or by a human editing criticality or rationale. It deliberately does *not*
 * suppress: the change was real, so seeing it again should wake someone again.
 */
reviewerRoutes.post(
  "/drift/findings/:id/correct",
  requireCapability("rationale:confirm"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));

    const updated = await db
      .update(driftFindings)
      .set({ state: "corrected", resolvedAt: new Date() })
      .where(
        and(
          eq(driftFindings.id, id),
          eq(driftFindings.orgId, orgId),
          inArray(driftFindings.state, resolvable as never),
        ),
      )
      .returning({ id: driftFindings.id });

    if (updated.length === 0) await explainWhyNot(orgId, id);

    await audit(c, "drift.corrected", { kind: "drift_finding", id });
    return c.json({ ok: true });
  },
);

/** 404 when it is not theirs, 409 when it is already resolved. */
async function explainWhyNot(orgId: number, id: number): Promise<never> {
  const [existing] = await db
    .select({ state: driftFindings.state })
    .from(driftFindings)
    .where(and(eq(driftFindings.id, id), eq(driftFindings.orgId, orgId)))
    .limit(1);

  if (!existing) throw new NotFoundError();
  throw new ConflictError(`This finding is already ${existing.state}`);
}
