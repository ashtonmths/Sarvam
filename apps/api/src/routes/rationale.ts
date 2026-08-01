import {
  edges as edgesTable,
  nodes as nodesTable,
  rationale,
  rationaleLinks,
} from "@sadhak/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { coverage } from "../historian/retrieve.js";
import { requireCapability } from "../middleware/auth.js";

// Two aliases so one query can name both ends of the edge a draft explains.
const srcNode = alias(nodesTable, "src_node");
const dstNode = alias(nodesTable, "dst_node");

export const rationaleRoutes = new Hono();

/**
 * The review queue, impact-ordered: humans confirm what matters first.
 */
rationaleRoutes.get("/rationale", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const state = c.req.query("state") ?? "drafted";

  const rows = await db
    .select({
      id: rationale.id,
      body: rationale.body,
      sourceKind: rationale.sourceKind,
      sourceUrl: rationale.sourceUrl,
      author: rationale.author,
      state: rationale.state,
      confidence: rationale.confidence,
      createdAt: rationale.createdAt,
      edgeId: rationaleLinks.edgeId,
      srcId: edgesTable.srcId,
      dstId: edgesTable.dstId,
      edgeKind: edgesTable.kind,
      srcName: srcNode.name,
      dstName: dstNode.name,
    })
    .from(rationale)
    .leftJoin(rationaleLinks, eq(rationaleLinks.rationaleId, rationale.id))
    .leftJoin(edgesTable, eq(edgesTable.id, rationaleLinks.edgeId))
    .leftJoin(srcNode, eq(srcNode.id, edgesTable.srcId))
    .leftJoin(dstNode, eq(dstNode.id, edgesTable.dstId))
    .where(and(eq(rationale.orgId, orgId), eq(rationale.state, state as "drafted")))
    .orderBy(desc(rationale.createdAt))
    .limit(100);

  return c.json({ items: rows });
});

/**
 * The action that moves the coverage metric. It gets a named human, an audit
 * row, and a capability check — Historian output alone can never move it.
 */
rationaleRoutes.post(
  "/rationale/:id/confirm",
  requireCapability("rationale:confirm"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const actor = c.get("actor");
    const actorLabel = actor.type === "user" ? actor.email : `api_key:${actor.id}`;

    const updated = await db
      .update(rationale)
      .set({ state: "confirmed", confirmedBy: actorLabel, confirmedAt: new Date() })
      .where(
        and(
          eq(rationale.id, id),
          eq(rationale.orgId, orgId),
          eq(rationale.state, "drafted"),
        ),
      )
      .returning({ id: rationale.id });

    if (updated.length === 0) {
      // Either it does not exist or it is not drafted. Confirmation is one-way
      // from the API; unwinding a bad confirm is an audited admin action.
      const exists = await db
        .select({ id: rationale.id })
        .from(rationale)
        .where(and(eq(rationale.id, id), eq(rationale.orgId, orgId)))
        .limit(1);
      if (exists.length === 0) throw new NotFoundError();
      throw new ConflictError("Only a drafted rationale can be confirmed");
    }

    await audit(c, "rationale.confirmed", { kind: "rationale", id });
    return c.json({ ok: true, id, state: "confirmed" });
  },
);

rationaleRoutes.post(
  "/rationale/:id/reject",
  requireCapability("rationale:confirm"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const body = z
      .object({ reason: z.string().max(500).optional() })
      .parse(await c.req.json().catch(() => ({})));

    const updated = await db
      .update(rationale)
      .set({ state: "rejected" })
      .where(
        and(
          eq(rationale.id, id),
          eq(rationale.orgId, orgId),
          eq(rationale.state, "drafted"),
        ),
      )
      .returning({ id: rationale.id });

    if (updated.length === 0)
      throw new ConflictError("Only a drafted rationale can be rejected");

    // Rejected rows are kept: deleting them would blind the acceptance-rate metric.
    await audit(
      c,
      "rationale.rejected",
      { kind: "rationale", id },
      {
        ...(body.reason ? { reason: body.reason } : {}),
      },
    );
    return c.json({ ok: true, id, state: "rejected" });
  },
);

/**
 * Two numbers, side by side, never summed. Drafts are reported *alongside*
 * coverage precisely so the system cannot inflate its own headline metric.
 */
rationaleRoutes.get("/metrics/coverage", requireCapability("graph:read"), async (c) => {
  const stats = await coverage(c.get("orgId"));
  return c.json({
    ...stats,
    note: "coverageConfirmed counts confirmed rationale only. Drafts are pending review and are never added to it.",
  });
});

/** Historian's worklist: edges with nothing linked. */
rationaleRoutes.get(
  "/rationale/unexplained",
  requireCapability("graph:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const rows = await db
      .select({
        edgeId: edgesTable.id,
        srcId: edgesTable.srcId,
        dstId: edgesTable.dstId,
        kind: edgesTable.kind,
        provenance: edgesTable.provenance,
      })
      .from(edgesTable)
      .where(
        and(
          eq(edgesTable.orgId, orgId),
          sql`NOT EXISTS (SELECT 1 FROM rationale_links rl WHERE rl.edge_id = ${edgesTable.id})`,
        ),
      )
      .limit(200);
    return c.json({ items: rows });
  },
);
