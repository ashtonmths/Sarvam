import {
  criticalityOverrides,
  edges as edgesTable,
  nodes as nodesTable,
  unresolvedRefs,
} from "@sadhak/shared/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { NotFoundError } from "../errors.js";
import { paginated, parsePagination } from "../http/pagination.js";
import { requireCapability } from "../middleware/auth.js";
import { toBlastRows } from "../sentinel/assemble.js";
import { verdict as scoreVerdict } from "../sentinel/score.js";
import { busFactorByEdge, hydrateHops, traverse } from "../sentinel/traverse.js";

export const graphRoutes = new Hono();

graphRoutes.get("/graph/nodes", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const { limit, cursor } = parsePagination(c.req.query());
  const kind = c.req.query("kind");
  const connector = c.req.query("connector");

  const filters = [eq(nodesTable.orgId, orgId)];
  if (kind) filters.push(eq(nodesTable.kind, kind as "table"));
  if (connector) filters.push(eq(nodesTable.connector, connector));
  if (cursor) {
    filters.push(
      or(
        lt(nodesTable.lastSeen, new Date(cursor.k)),
        and(eq(nodesTable.lastSeen, new Date(cursor.k)), lt(nodesTable.id, cursor.i)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(nodesTable)
    .where(and(...filters))
    .orderBy(desc(nodesTable.lastSeen), desc(nodesTable.id))
    .limit(limit + 1);

  return c.json(
    paginated(rows, limit, (row) => ({ k: row.lastSeen.toISOString(), i: row.id })),
  );
});

graphRoutes.get("/graph/edges", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const { limit, cursor } = parsePagination(c.req.query());

  const filters = [eq(edgesTable.orgId, orgId)];
  if (cursor) {
    filters.push(
      or(
        lt(edgesTable.lastSeen, new Date(cursor.k)),
        and(eq(edgesTable.lastSeen, new Date(cursor.k)), lt(edgesTable.id, cursor.i)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(edgesTable)
    .where(and(...filters))
    .orderBy(desc(edgesTable.lastSeen), desc(edgesTable.id))
    .limit(limit + 1);

  return c.json(
    paginated(rows, limit, (row) => ({ k: row.lastSeen.toISOString(), i: row.id })),
  );
});

/**
 * The most dangerous things to touch right now, ranked by the gate's own
 * arithmetic — a real traversal per candidate, not an approximation. Read-only,
 * so nothing here writes a decision row.
 *
 * Bounded to a handful of candidates: this runs on a dashboard, and the point
 * is the top of the list, not completeness.
 */
graphRoutes.get("/graph/watchlist", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const limit = Math.min(Number(c.req.query("limit") ?? 3), 10);

  // Only nodes something actually depends on — a leaf has no blast radius, so
  // scoring it would just pad the list with zeros.
  const candidates = await db
    .select({
      id: nodesTable.id,
      name: nodesTable.name,
      kind: nodesTable.kind,
      connector: nodesTable.connector,
      externalId: nodesTable.externalId,
      criticality: nodesTable.criticality,
    })
    .from(nodesTable)
    .where(
      and(
        eq(nodesTable.orgId, orgId),
        eq(nodesTable.state, "active"),
        sql`EXISTS (SELECT 1 FROM edges e WHERE e.dst_id = ${nodesTable.id} AND e.org_id = ${orgId})`,
      ),
    )
    .orderBy(desc(nodesTable.criticality))
    .limit(limit * 4);

  const scored = [];
  for (const node of candidates) {
    const rows = await traverse(orgId, node.id);
    if (rows.length === 0) continue;

    const edgeIds = [...new Set(rows.flatMap((r) => r.edgeIds))];
    const [hops, authors] = await Promise.all([
      hydrateHops(orgId, edgeIds),
      busFactorByEdge(orgId, edgeIds),
    ]);
    const impacted = toBlastRows(rows, hops, authors);
    const { verdict } = scoreVerdict(impacted);

    scored.push({
      node,
      downstream: impacted.length,
      maxImpact: impacted.reduce((max, r) => Math.max(max, r.impact), 0),
      verdict,
    });
  }

  scored.sort((a, b) => b.maxImpact - a.maxImpact);
  return c.json({ items: scored.slice(0, limit) });
});

/** Counts by kind, connector and state — what `sadhak graph stats` renders. */
graphRoutes.get("/graph/stats", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");

  const byKind = await db
    .select({ kind: nodesTable.kind, count: sql<number>`count(*)::int` })
    .from(nodesTable)
    .where(eq(nodesTable.orgId, orgId))
    .groupBy(nodesTable.kind);

  const byConnector = await db
    .select({ connector: nodesTable.connector, count: sql<number>`count(*)::int` })
    .from(nodesTable)
    .where(eq(nodesTable.orgId, orgId))
    .groupBy(nodesTable.connector);

  const byState = await db
    .select({ state: nodesTable.state, count: sql<number>`count(*)::int` })
    .from(nodesTable)
    .where(eq(nodesTable.orgId, orgId))
    .groupBy(nodesTable.state);

  const edgesByProvenance = await db
    .select({ provenance: edgesTable.provenance, count: sql<number>`count(*)::int` })
    .from(edgesTable)
    .where(eq(edgesTable.orgId, orgId))
    .groupBy(edgesTable.provenance);

  const edgesByState = await db
    .select({ state: edgesTable.state, count: sql<number>`count(*)::int` })
    .from(edgesTable)
    .where(eq(edgesTable.orgId, orgId))
    .groupBy(edgesTable.state);

  const [unresolvedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(unresolvedRefs)
    .where(eq(unresolvedRefs.orgId, orgId));

  return c.json({
    nodes: {
      total: byKind.reduce((sum, row) => sum + row.count, 0),
      byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.count])),
      byConnector: Object.fromEntries(byConnector.map((r) => [r.connector, r.count])),
      byState: Object.fromEntries(byState.map((r) => [r.state, r.count])),
    },
    edges: {
      total: edgesByProvenance.reduce((sum, row) => sum + row.count, 0),
      byProvenance: Object.fromEntries(
        edgesByProvenance.map((r) => [r.provenance, r.count]),
      ),
      byState: Object.fromEntries(edgesByState.map((r) => [r.state, r.count])),
    },
    unresolvedRefs: unresolvedCount?.count ?? 0,
  });
});

/**
 * The moat data. The override and its audit row land in one transaction, and
 * `criticality_source = 'human'` is what stops every future crawl from
 * clobbering the correction.
 */
graphRoutes.patch(
  "/nodes/:nodeId/criticality",
  requireCapability("criticality:edit"),
  async (c) => {
    const orgId = c.get("orgId");
    const nodeId = Number(c.req.param("nodeId"));
    const body = z
      .object({ value: z.number().min(0).max(1), reason: z.string().min(1).max(500) })
      .parse(await c.req.json());

    const [node] = await db
      .select({ id: nodesTable.id, criticality: nodesTable.criticality })
      .from(nodesTable)
      .where(and(eq(nodesTable.id, nodeId), eq(nodesTable.orgId, orgId)))
      .limit(1);
    if (!node) throw new NotFoundError();

    const actor = c.get("actor");
    const actorLabel = actor.type === "user" ? `user:${actor.id}` : `api_key:${actor.id}`;

    await db.transaction(async (tx) => {
      await tx
        .update(nodesTable)
        .set({ criticality: body.value, criticalitySource: "human" })
        .where(eq(nodesTable.id, nodeId));

      await tx.insert(criticalityOverrides).values({
        orgId,
        nodeId,
        oldValue: node.criticality,
        newValue: body.value,
        actor: actorLabel,
        reason: body.reason,
      });
    });

    await audit(
      c,
      "criticality.edited",
      { kind: "node", id: nodeId },
      {
        from: node.criticality,
        to: body.value,
        reason: body.reason,
      },
    );

    return c.json({ ok: true, nodeId, criticality: body.value });
  },
);

graphRoutes.get(
  "/nodes/:nodeId/criticality/history",
  requireCapability("graph:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const nodeId = Number(c.req.param("nodeId"));

    const rows = await db
      .select()
      .from(criticalityOverrides)
      .where(
        and(
          eq(criticalityOverrides.orgId, orgId),
          eq(criticalityOverrides.nodeId, nodeId),
        ),
      )
      .orderBy(desc(criticalityOverrides.createdAt));

    return c.json({ items: rows });
  },
);

graphRoutes.get("/graph/unresolved", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const rows = await db
    .select()
    .from(unresolvedRefs)
    .where(eq(unresolvedRefs.orgId, orgId))
    .orderBy(desc(unresolvedRefs.createdAt))
    .limit(100);
  return c.json({ items: rows });
});
