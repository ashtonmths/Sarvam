import type { ExternalRef, NodeKey } from "../connectors/types.js";

/**
 * Cross-connector entity resolution — the competitive delta. An n8n step that
 * writes Airtable table `tblX` and the Airtable crawler's `tblX` must be one
 * node, or the blast radius dies at the vendor boundary.
 *
 * The mechanism is identity resolution, not record merging: the *data*
 * connector owns the canonical key, the n8n crawler only emits references, and
 * because the upsert key is (org, connector, external_id), two crawls that
 * produce the same canonical key fuse automatically. Crawl order cannot matter.
 */

export type Resolution =
  | { status: "resolved"; key: NodeKey; resolvedBy: "vendor_id" | "connection" | "name" }
  | { status: "unresolved"; reason: string; candidates: string[] };

export interface FusionCatalog {
  /** Canonical external ids that already exist in the org, by connector. */
  known: Map<string, Set<string>>;
  /** Airtable table name → canonical table external ids (for name matching). */
  airtableTablesByName: Map<string, string[]>;
  /** Postgres `schema.table` → canonical table external ids. */
  postgresTablesByName: Map<string, string[]>;
}

export function emptyCatalog(): FusionCatalog {
  return {
    known: new Map(),
    airtableTablesByName: new Map(),
    postgresTablesByName: new Map(),
  };
}

/**
 * Ordered rules. Each is pure; ambiguity never fuses, it queues for Reviewer —
 * a confidently wrong blast radius is worse than an incomplete one.
 */
export function resolveRef(ref: ExternalRef, catalog: FusionCatalog): Resolution {
  // 1. Exact vendor id — the id is literally in the flow JSON.
  if (ref.system === "airtable") {
    if (ref.fieldId) {
      return {
        status: "resolved",
        key: { connector: "airtable", externalId: `field/${ref.fieldId}` },
        resolvedBy: "vendor_id",
      };
    }
    if (ref.tableId) {
      return {
        status: "resolved",
        key: { connector: "airtable", externalId: `table/${ref.tableId}` },
        resolvedBy: "vendor_id",
      };
    }
    if (ref.baseId && !ref.tableName) {
      return {
        status: "resolved",
        key: { connector: "airtable", externalId: `base/${ref.baseId}` },
        resolvedBy: "vendor_id",
      };
    }

    // 3. Unambiguous name match — older n8n nodes store table names.
    if (ref.tableName) {
      const candidates =
        catalog.airtableTablesByName.get(ref.tableName.toLowerCase()) ?? [];
      if (candidates.length === 1 && candidates[0]) {
        return {
          status: "resolved",
          key: { connector: "airtable", externalId: candidates[0] },
          resolvedBy: "name",
        };
      }
      return {
        status: "unresolved",
        reason:
          candidates.length === 0
            ? `no Airtable table named "${ref.tableName}" has been crawled`
            : `"${ref.tableName}" matches ${candidates.length} Airtable tables`,
        candidates,
      };
    }
  }

  // 2. Connection-metadata match — schema and table are literal in the params,
  //    so the only ambiguity is which registered Postgres instance they mean.
  if (ref.system === "postgres") {
    const qualified = `${ref.schema}.${ref.table}`.toLowerCase();
    const candidates = catalog.postgresTablesByName.get(qualified) ?? [];
    if (candidates.length === 1 && candidates[0]) {
      const tableId = candidates[0];
      return {
        status: "resolved",
        key: {
          connector: "postgres",
          externalId: ref.column
            ? `${tableId.replace(/\/table\//, "/column/")}.${ref.column}`
            : tableId,
        },
        resolvedBy: "connection",
      };
    }
    return {
      status: "unresolved",
      reason:
        candidates.length === 0
          ? `no crawled Postgres instance contains ${qualified}`
          : `${qualified} exists in ${candidates.length} crawled Postgres instances`,
      candidates,
    };
  }

  if (ref.system === "http") {
    // Hosts are their own canonical identity, and always resolvable.
    return {
      status: "resolved",
      key: { connector: "http", externalId: `endpoint/${ref.host}` },
      resolvedBy: "vendor_id",
    };
  }

  return { status: "unresolved", reason: "unrecognized reference shape", candidates: [] };
}

/**
 * A resolved key that no crawl has produced yet gets a placeholder node under
 * the canonical key; the later crawl upserts onto the same key and fills it in.
 */
export function placeholderFor(key: NodeKey): {
  key: NodeKey;
  kind: "table" | "field" | "service" | "endpoint";
  name: string;
  metadata: Record<string, unknown>;
} {
  const [prefix] = key.externalId.split("/");
  const kind =
    prefix === "field" || key.externalId.includes("/column/")
      ? "field"
      : prefix === "endpoint"
        ? "endpoint"
        : prefix === "base"
          ? "service"
          : "table";

  return {
    key,
    kind,
    name: key.externalId.split("/").slice(1).join("/") || key.externalId,
    metadata: { placeholder: true },
  };
}
