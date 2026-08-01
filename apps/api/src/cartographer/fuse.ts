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

/**
 * Name maps are keyed twice: bare (`orders`) and scoped (`appABC::orders`).
 *
 * A reference that names its base or database must only ever match within it.
 * Matching on the bare name alone fuses across boundaries — a staging workflow
 * referencing `Orders` resolves to production's `Orders` whenever staging's
 * copy is named anything else, and the gate then blocks a production change
 * citing a staging workflow as an affected dependent. The bare key stays for
 * references that genuinely carry no scope.
 */
export function scopedNameKey(scope: string, name: string): string {
  return `${scope.toLowerCase()}::${name.toLowerCase()}`;
}

export interface FusionCatalog {
  /** Canonical external ids that already exist in the org, by connector. */
  known: Map<string, Set<string>>;
  /** Airtable table name and `baseId::name` → canonical table external ids. */
  airtableTablesByName: Map<string, string[]>;
  /** Postgres `schema.table` and `database::schema.table` → canonical ids. */
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
      // Scoped to the base when the reference names one. Never falls back to
      // the bare name: "not in that base" is a different answer from "not
      // crawled", and silently widening the search is the false merge.
      const lookup = ref.baseId
        ? scopedNameKey(ref.baseId, ref.tableName)
        : ref.tableName.toLowerCase();
      const candidates = catalog.airtableTablesByName.get(lookup) ?? [];
      if (candidates.length === 1 && candidates[0]) {
        return {
          status: "resolved",
          key: { connector: "airtable", externalId: candidates[0] },
          resolvedBy: "name",
        };
      }
      const where = ref.baseId ? ` in base ${ref.baseId}` : "";
      return {
        status: "unresolved",
        reason:
          candidates.length === 0
            ? `no Airtable table named "${ref.tableName}"${where} has been crawled`
            : `"${ref.tableName}"${where} matches ${candidates.length} Airtable tables`,
        candidates,
      };
    }
  }

  // 2. Connection-metadata match — schema and table are literal in the params,
  //    so the only ambiguity is which registered Postgres instance they mean.
  if (ref.system === "postgres") {
    const qualified = `${ref.schema}.${ref.table}`.toLowerCase();
    // Scoped to the database when the reference names one, for the same
    // reason as Airtable's base: `public.invoices` in two connected databases
    // is two different tables, and picking whichever one happens to be crawled
    // is a cross-database false merge.
    const lookup = ref.database ? scopedNameKey(ref.database, qualified) : qualified;
    const candidates = catalog.postgresTablesByName.get(lookup) ?? [];
    const where = ref.database ? ` in database ${ref.database}` : "";

    if (candidates.length === 1 && candidates[0]) {
      const tableId = candidates[0];
      if (!ref.column) {
        return {
          status: "resolved",
          key: { connector: "postgres", externalId: tableId },
          resolvedBy: "connection",
        };
      }

      /**
       * The column id is derived from the table's, so it is a guess until the
       * catalog confirms it. Unchecked, a step still selecting a column that
       * was dropped last month re-invents a node for it on every crawl — one
       * nothing can tombstone, and whose name seeds criticality as though it
       * were real.
       *
       * When the column is unknown the edge lands on the table instead of
       * being dropped. Reaching here means the table resolved, so Postgres has
       * been crawled and the column really is absent; the dependency on the
       * table is still true, just coarser. Returning unresolved would be worse
       * than coarse: unresolved endpoints count toward the 5% skip ceiling
       * that fails a crawl outright, and view columns are deliberately never
       * emitted, so that ceiling would be hit by ordinary schemas.
       */
      const columnId = `${tableId.replace(/\/table\//, "/column/")}.${ref.column}`;
      const columnExists = catalog.known.get("postgres")?.has(columnId) ?? false;
      return {
        status: "resolved",
        key: { connector: "postgres", externalId: columnExists ? columnId : tableId },
        resolvedBy: "connection",
      };
    }

    return {
      status: "unresolved",
      reason:
        candidates.length === 0
          ? `no crawled Postgres instance contains ${qualified}${where}`
          : `${qualified}${where} exists in ${candidates.length} crawled Postgres instances`,
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
