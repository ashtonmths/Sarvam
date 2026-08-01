import {
  connectorInstances,
  crawls,
  nodes as nodesTable,
  unresolvedRefs,
} from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { getConnector, makeReadContext } from "../connectors/registry.js";
import type { EdgeSpec, ExternalRef, NodeKey, NodeSpec } from "../connectors/types.js";
import { db } from "../db.js";
import { NotFoundError, UserError } from "../errors.js";
import { enqueueUnexplainedEdges } from "../historian/enqueue.js";
import { getReadCredential } from "../vault/vault.js";
import { emptyCatalog, type FusionCatalog, placeholderFor, resolveRef } from "./fuse.js";
import {
  type NormalizedEdge,
  type NormalizedNode,
  normalizeEdge,
  normalizeNode,
} from "./normalize.js";
import { reconcile } from "./reconcile.js";

/**
 * runCrawl: create the crawls row → stream connector specs through normalize →
 * resolve and fuse → reconcile → finalize stats. Budgets are enforced here
 * rather than trusted from connector goodwill.
 */

const WALL_CLOCK_MS = { full: 10 * 60_000, incremental: 2 * 60_000 };
/** A crawl that silently drops half the graph is worse than one that fails. */
const MAX_SKIP_RATE = 0.05;

export interface CrawlOutcome {
  crawlId: number;
  state: "succeeded" | "failed";
  stats: Record<string, number>;
  error?: string;
}

export async function runCrawl(
  orgId: number,
  instanceId: number,
  kind: "full" | "incremental" = "full",
  signal?: AbortSignal,
): Promise<CrawlOutcome> {
  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.id, instanceId), eq(connectorInstances.orgId, orgId)),
    )
    .limit(1);
  if (!instance) throw new NotFoundError("Connector instance not found");

  if (instance.status === "disabled") {
    throw new UserError("This connector instance is disabled");
  }

  const startedAt = new Date();
  const [crawlRow] = await db
    .insert(crawls)
    .values({
      orgId,
      connectorInstanceId: instanceId,
      kind,
      state: "running",
      startedAt,
    })
    .returning({ id: crawls.id });
  const crawlId = crawlRow?.id ?? 0;

  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), WALL_CLOCK_MS[kind]);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const secret = await getReadCredential(orgId, instanceId, `crawl:${crawlId}`);
    if (!secret) {
      throw new UserError("No read credential is stored for this connector instance");
    }

    const connector = getConnector(instance.connector);
    const ctx = makeReadContext(orgId, instance, secret, controller.signal);
    const result = await connector.crawl(ctx);

    const { nodes, edges, skipped, unresolved } = await fuseAndNormalize(
      orgId,
      result.nodes,
      result.edges,
    );

    const totalSpecs = result.nodes.length + result.edges.length;
    if (totalSpecs > 0 && skipped / totalSpecs > MAX_SKIP_RATE) {
      throw new UserError(
        `Crawl skipped ${skipped} of ${totalSpecs} entities (>${MAX_SKIP_RATE * 100}%) — failing rather than persisting a partial graph`,
      );
    }

    const reconcileStats = await reconcile({
      orgId,
      connectorInstanceId: instanceId,
      ownedConnectors: [instance.connector],
      nodes,
      edges,
      crawlStartedAt: startedAt,
      // Only a successful *full* crawl may tombstone.
      markStale: kind === "full",
    });

    if (unresolved.length > 0) {
      await db.insert(unresolvedRefs).values(
        unresolved.map((entry) => ({
          orgId,
          crawlId,
          raw: entry.raw,
          candidates: entry.candidates,
        })),
      );
    }

    const stats = {
      ...reconcileStats,
      skipped,
      unresolved: unresolved.length,
      durationMs: Date.now() - startedAt.getTime(),
    };

    await db
      .update(crawls)
      .set({ state: "succeeded", finishedAt: new Date(), stats })
      .where(eq(crawls.id, crawlId));

    await db
      .update(connectorInstances)
      .set({
        status: "active",
        statusDetail: null,
        lastCrawlAt: new Date(),
        lastCrawlError: null,
        consecutiveFailures: 0,
        breakerOpenUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(connectorInstances.id, instanceId));

    // A successful crawl is what gives Historian its worklist.
    void enqueueUnexplainedEdges(orgId).catch(() => undefined);

    return { crawlId, state: "succeeded", stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await db
      .update(crawls)
      .set({ state: "failed", finishedAt: new Date(), error: message })
      .where(eq(crawls.id, crawlId));

    // DB-backed breaker so the API process and the worker share state.
    const failures = (instance.consecutiveFailures ?? 0) + 1;
    await db
      .update(connectorInstances)
      .set({
        status: failures >= 5 ? "degraded" : "error",
        statusDetail: message.slice(0, 500),
        lastCrawlError: message.slice(0, 500),
        consecutiveFailures: failures,
        breakerOpenUntil:
          failures >= 5
            ? new Date(Date.now() + 60_000 * 2 ** Math.min(failures - 5, 5))
            : null,
        updatedAt: new Date(),
      })
      .where(eq(connectorInstances.id, instanceId));

    return { crawlId, state: "failed", stats: {}, error: message };
  } finally {
    clearTimeout(budget);
  }
}

interface FusionOutput {
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
  skipped: number;
  unresolved: Array<{ raw: Record<string, unknown>; candidates: unknown[] }>;
}

/**
 * Normalization is per-entity and forgiving: one malformed spec increments
 * `skipped`, it does not kill the crawl (the >5% rule above is what protects
 * the graph from a systematically broken parser).
 */
async function fuseAndNormalize(
  orgId: number,
  nodeSpecs: NodeSpec[],
  edgeSpecs: EdgeSpec[],
): Promise<FusionOutput> {
  const catalog = await loadCatalog(orgId);
  const nodes: NormalizedNode[] = [];
  const edges: NormalizedEdge[] = [];
  const unresolved: FusionOutput["unresolved"] = [];
  let skipped = 0;

  for (const spec of nodeSpecs) {
    try {
      const normalized = normalizeNode(spec);
      nodes.push(normalized);
      registerInCatalog(catalog, normalized);
    } catch {
      skipped += 1;
    }
  }

  const emittedKeys = new Set(nodes.map((n) => `${n.connector}::${n.externalId}`));

  for (const spec of edgeSpecs) {
    const src = resolveEndpoint(spec.src, catalog);
    const dst = resolveEndpoint(spec.dst, catalog);

    if (!src.key || !dst.key) {
      for (const side of [src, dst]) {
        if (!side.key && side.ref) {
          unresolved.push({
            raw: side.ref as unknown as Record<string, unknown>,
            candidates: side.candidates ?? [],
          });
        }
      }
      skipped += 1;
      continue;
    }

    // A resolved key no crawl has produced yet becomes a placeholder; the
    // later crawl upserts onto the same key and fills it in.
    for (const key of [src.key, dst.key]) {
      const id = `${key.connector}::${key.externalId}`;
      if (emittedKeys.has(id)) continue;
      if (catalog.known.get(key.connector)?.has(key.externalId)) continue;
      try {
        const placeholder = normalizeNode(placeholderFor(key));
        nodes.push(placeholder);
        emittedKeys.add(id);
      } catch {
        skipped += 1;
      }
    }

    try {
      edges.push(
        normalizeEdge({
          src: src.key,
          dst: dst.key,
          kind: spec.kind,
          provenance: spec.provenance,
        }),
      );
    } catch {
      skipped += 1;
    }
  }

  return { nodes, edges, skipped, unresolved };
}

function resolveEndpoint(
  endpoint: NodeKey | ExternalRef,
  catalog: FusionCatalog,
): { key: NodeKey | null; ref?: ExternalRef; candidates?: unknown[] } {
  if ("connector" in endpoint) return { key: endpoint };

  const resolution = resolveRef(endpoint, catalog);
  if (resolution.status === "resolved") return { key: resolution.key };
  return { key: null, ref: endpoint, candidates: resolution.candidates };
}

async function loadCatalog(orgId: number): Promise<FusionCatalog> {
  const catalog = emptyCatalog();
  const rows = await db
    .select({
      connector: nodesTable.connector,
      externalId: nodesTable.externalId,
      kind: nodesTable.kind,
      name: nodesTable.name,
    })
    .from(nodesTable)
    .where(eq(nodesTable.orgId, orgId));

  for (const row of rows) {
    registerInCatalog(catalog, row);
  }
  return catalog;
}

function registerInCatalog(
  catalog: FusionCatalog,
  node: { connector: string; externalId: string; kind: string; name: string },
): void {
  let known = catalog.known.get(node.connector);
  if (!known) {
    known = new Set();
    catalog.known.set(node.connector, known);
  }
  known.add(node.externalId);

  if (node.connector === "airtable" && node.externalId.startsWith("table/")) {
    push(catalog.airtableTablesByName, node.name.toLowerCase(), node.externalId);
  }
  if (node.connector === "postgres" && node.externalId.includes("/table/")) {
    const qualified = node.externalId.split("/table/")[1]?.toLowerCase();
    if (qualified) push(catalog.postgresTablesByName, qualified, node.externalId);
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(value)) existing.push(value);
  } else {
    map.set(key, [value]);
  }
}
