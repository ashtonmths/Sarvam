import { edges as edgesTable, nodes as nodesTable } from "@sadhak/shared/schema";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db.js";
import { seedCriticality } from "./criticality.js";
import type { NormalizedEdge, NormalizedNode } from "./normalize.js";

/**
 * Crawls repeat; the graph must converge without destroying history. A
 * disappeared node is tombstoned, never deleted — deleting it would cascade
 * away its edges and any linked rationale, which is exactly the evidence the
 * audit trail needs.
 */

const BATCH = 500;

export interface ReconcileStats {
  nodesSeen: number;
  edgesSeen: number;
  nodesStaled: number;
  edgesStaled: number;
}

export interface ReconcileInput {
  orgId: number;
  connectorInstanceId: number;
  /** Which connector namespaces this crawl is authoritative for. */
  ownedConnectors: string[];
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
  crawlStartedAt: Date;
  /** Stale-marking runs only after a *successful full* crawl. */
  markStale: boolean;
}

/** The transaction handle, so the body cannot accidentally use the pool. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * One transaction for the whole reconcile.
 *
 * Node upserts, edge upserts and the two stale sweeps were four independent
 * autocommit groups, and the gaps between them are readable: a verdict landing
 * between the node and edge batches sees new nodes carrying none of their
 * edges, computes a blast radius of zero, and approves a change it should have
 * blocked. The sweeps have the same window in reverse.
 *
 * It also makes a mid-crawl crash leave nothing behind instead of a half-built
 * graph that the next crawl has to converge back out of.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileStats> {
  return db.transaction((tx) => reconcileWithin(tx, input));
}

async function reconcileWithin(db: Tx, input: ReconcileInput): Promise<ReconcileStats> {
  const stats: ReconcileStats = {
    nodesSeen: input.nodes.length,
    edgesSeen: input.edges.length,
    nodesStaled: 0,
    edgesStaled: 0,
  };

  // Deduplicate by identity — a crawl legitimately emits the same credential
  // node once per referencing step.
  const uniqueNodes = new Map<string, NormalizedNode>();
  for (const node of input.nodes) {
    uniqueNodes.set(`${node.connector}::${node.externalId}`, node);
  }

  const idByKey = new Map<string, number>();

  for (const batch of chunk([...uniqueNodes.values()], BATCH)) {
    const rows = await db
      .insert(nodesTable)
      .values(
        batch.map((node) => ({
          orgId: input.orgId,
          kind: node.kind,
          name: node.name,
          externalId: node.externalId,
          connector: node.connector,
          connectorInstanceId: input.connectorInstanceId,
          criticality: seedCriticality(node),
          metadata: node.metadata,
          lastSeen: input.crawlStartedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [nodesTable.orgId, nodesTable.connector, nodesTable.externalId],
        set: {
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          // A real crawl overwrites a placeholder's metadata; nothing else does.
          metadata: sql`excluded.metadata`,
          lastSeen: sql`excluded.last_seen`,
          // Reappearance resurrects a tombstone, keeping the same node id.
          state: sql`'active'`,
          staleSince: sql`NULL`,
          /**
           * A cross-vendor node is first created as a placeholder by whichever
           * crawl referenced it, carrying that crawl's instance id. The real
           * crawl that owns it must take it over, or the owner's stale sweep
           * filters it out forever and the node can never be tombstoned.
           * Claiming happens only in that direction: a placeholder never takes
           * a node away from the connector that actually crawls it.
           */
          connectorInstanceId: sql`
            CASE WHEN ${nodesTable.metadata}->>'placeholder' = 'true'
                  AND excluded.metadata->>'placeholder' IS DISTINCT FROM 'true'
                 THEN excluded.connector_instance_id
                 ELSE ${nodesTable.connectorInstanceId} END`,
          /**
           * Criticality is insert-only so a re-crawl cannot clobber a human
           * override — but a placeholder's seed is not an override, it is a
           * guess made from an external id. `tblABC` seeds the 0.4 default;
           * the real crawl names it `Invoices`, which seeds 1.0, and without
           * this the most revenue-critical table in the graph stays scored as
           * ordinary tooling forever. Only the placeholder→real transition
           * re-seeds; every other re-crawl still leaves it alone.
           */
          criticality: sql`
            CASE WHEN ${nodesTable.metadata}->>'placeholder' = 'true'
                  AND excluded.metadata->>'placeholder' IS DISTINCT FROM 'true'
                 THEN excluded.criticality
                 ELSE ${nodesTable.criticality} END`,
        },
      })
      .returning({
        id: nodesTable.id,
        connector: nodesTable.connector,
        externalId: nodesTable.externalId,
      });

    for (const row of rows) {
      idByKey.set(`${row.connector}::${row.externalId}`, row.id);
    }
  }

  // Any node the batch referenced but did not return (unchanged rows on some
  // conflict paths) still needs its id for edge insertion.
  const missing = [...uniqueNodes.values()].filter(
    (n) => !idByKey.has(`${n.connector}::${n.externalId}`),
  );
  if (missing.length > 0) {
    const rows = await db
      .select({
        id: nodesTable.id,
        connector: nodesTable.connector,
        externalId: nodesTable.externalId,
      })
      .from(nodesTable)
      .where(
        and(
          eq(nodesTable.orgId, input.orgId),
          inArray(
            nodesTable.externalId,
            missing.map((n) => n.externalId),
          ),
        ),
      );
    for (const row of rows) idByKey.set(`${row.connector}::${row.externalId}`, row.id);
  }

  const resolvedEdges = input.edges
    .map((edge) => {
      const srcId = idByKey.get(`${edge.srcConnector}::${edge.srcExternalId}`);
      const dstId = idByKey.get(`${edge.dstConnector}::${edge.dstExternalId}`);
      if (!srcId || !dstId || srcId === dstId) return null;
      return {
        orgId: input.orgId,
        srcId,
        dstId,
        kind: edge.kind,
        confidence: edge.confidence,
        provenance: edge.provenance,
        lastSeen: input.crawlStartedAt,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Same (src,dst,kind) from two paths would violate the unique index mid-batch.
  const uniqueEdges = new Map(
    resolvedEdges.map((e) => [`${e.srcId}:${e.dstId}:${e.kind}`, e]),
  );

  for (const batch of chunk([...uniqueEdges.values()], BATCH)) {
    await db
      .insert(edgesTable)
      .values(batch)
      .onConflictDoUpdate({
        target: [edgesTable.srcId, edgesTable.dstId, edgesTable.kind],
        set: {
          confidence: sql`excluded.confidence`,
          provenance: sql`excluded.provenance`,
          lastSeen: sql`excluded.last_seen`,
          state: sql`'active'`,
          staleSince: sql`NULL`,
        },
      });
  }

  // A failed or partial crawl marks nothing: a connector outage must never
  // tombstone half the graph.
  if (input.markStale) {
    const staleNodes = await db
      .update(nodesTable)
      .set({ state: "stale", staleSince: new Date() })
      .where(
        and(
          eq(nodesTable.orgId, input.orgId),
          eq(nodesTable.connectorInstanceId, input.connectorInstanceId),
          inArray(nodesTable.connector, input.ownedConnectors),
          lt(nodesTable.lastSeen, input.crawlStartedAt),
          eq(nodesTable.state, "active"),
        ),
      )
      .returning({ id: nodesTable.id });
    stats.nodesStaled = staleNodes.length;

    /**
     * Edges this crawl owns but no longer emits.
     *
     * Without this an edge was only ever tombstoned as collateral of one of
     * its endpoints disappearing, so *removing a dependency* was invisible:
     * point an n8n step at a different table and all three nodes still exist,
     * nothing goes stale, and the old edge keeps routing blast radius and
     * blocking merges on a dependency that is gone.
     *
     * A crawl is authoritative for edges leaving the nodes it owns, which is
     * what the subquery says. Scoping by org alone would let each connector's
     * crawl tombstone every other connector's edges.
     */
    const ownedNodeIds = db
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(
        and(
          eq(nodesTable.orgId, input.orgId),
          eq(nodesTable.connectorInstanceId, input.connectorInstanceId),
          inArray(nodesTable.connector, input.ownedConnectors),
        ),
      );

    const unseenEdges = await db
      .update(edgesTable)
      .set({ state: "stale", staleSince: new Date() })
      .where(
        and(
          eq(edgesTable.orgId, input.orgId),
          eq(edgesTable.state, "active"),
          lt(edgesTable.lastSeen, input.crawlStartedAt),
          inArray(edgesTable.srcId, ownedNodeIds),
        ),
      )
      .returning({ id: edgesTable.id });
    stats.edgesStaled = unseenEdges.length;

    /**
     * Then the collateral pass, for edges *into* a node that vanished whose
     * source belongs to a different connector — those are not covered above.
     * Chunked because this list is not bounded by BATCH the way the upserts
     * are, and a wide sweep would otherwise exceed Postgres's bind-parameter
     * ceiling after the upserts have already committed.
     */
    for (const idChunk of chunk(
      staleNodes.map((n) => n.id),
      BATCH,
    )) {
      const staleEdges = await db
        .update(edgesTable)
        .set({ state: "stale", staleSince: new Date() })
        .where(
          and(
            eq(edgesTable.orgId, input.orgId),
            eq(edgesTable.state, "active"),
            sql`(${edgesTable.srcId} IN ${idChunk} OR ${edgesTable.dstId} IN ${idChunk})`,
          ),
        )
        .returning({ id: edgesTable.id });
      stats.edgesStaled += staleEdges.length;
    }
  }

  return stats;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
