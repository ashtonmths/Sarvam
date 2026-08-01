import type { CrawlResult } from "../connectors/types.js";
import type { EntityScope } from "./drift.js";
import { canonicalHash } from "./hash.js";

/**
 * Turns a crawl result into the entity scopes the drift gate compares.
 *
 * Scope granularity is one node plus the edges leaving it. That is finer than
 * "one workflow", which costs more rows per instance — but it is
 * connector-agnostic, and it makes a finding point at the field that changed
 * rather than at the workflow containing it. For a graph of thousands of nodes
 * that trade is right; if an instance ever reaches a scale where per-node rows
 * hurt, the coarsening belongs here and nowhere else.
 *
 * A node's hash covers what the map would record about it — kind, name,
 * metadata, and its outgoing edges. It deliberately excludes ids we assign,
 * because a re-crawl that renumbers nothing must not look like drift.
 */
export function collectScopes(result: CrawlResult, connector: string): EntityScope[] {
  const edgesBySource = new Map<string, unknown[]>();

  for (const edge of result.edges) {
    // Only edges whose source is a node this connector owns can be attributed
    // to a scope here; a cross-connector reference is resolved later by fusion
    // and belongs to whichever crawl owns its source.
    const src = edge.src;
    if (!("externalId" in src)) continue;

    const list = edgesBySource.get(src.externalId) ?? [];
    list.push({
      kind: edge.kind,
      provenance: edge.provenance,
      dst: "externalId" in edge.dst ? edge.dst.externalId : edge.dst,
    });
    edgesBySource.set(src.externalId, list);
  }

  return result.nodes.map((node) => {
    const outgoing = [...(edgesBySource.get(node.key.externalId) ?? [])];
    // Sorted, because the order a provider lists connections in is not a fact
    // about the customer's system and must not read as drift.
    outgoing.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    const structure = {
      kind: node.kind,
      name: node.name,
      metadata: node.metadata,
      edges: outgoing,
    };

    return {
      scope: `${node.kind}/${node.key.externalId}`,
      hash: canonicalHash(structure, { connector }),
      live: { name: node.name, kind: node.kind, edgeCount: outgoing.length },
    };
  });
}
