import type {
  Connector,
  ConnectorDescriptor,
  CrawlResult,
  EdgeSpec,
  NodeSpec,
  ReadContext,
} from "../types.js";

/**
 * Airtable Meta API. Airtable's own ids (`app…`/`tbl…`/`fld…`) are the best
 * identity in the whole system — they are exactly what n8n step parameters
 * contain, which is what makes fusion exact rather than fuzzy.
 */

export const descriptor: ConnectorDescriptor = {
  slug: "airtable",
  displayName: "Airtable",
  auth: "api_key",
  readScopes: [
    {
      scope: "schema.bases:read",
      purpose: "Read base, table and field names and types. Never record contents.",
    },
  ],
  writeScopes: [
    {
      scope: "schema.bases:write",
      purpose: "Recreate a deleted field during a Reflex revert. Granted separately.",
    },
  ],
  webhooks: true,
  revertible: true,
  crawls: true,
};

/**
 * The record endpoint (`/v0/{baseId}/{tableIdOrName}`) is deliberately absent:
 * fetching rows is a thrown error, not a code-review catch.
 */
export const ALLOWED_PATHS = [
  /^\/v0\/meta\/bases(\?.*)?$/,
  /^\/v0\/meta\/bases\/[A-Za-z0-9]+\/tables(\?.*)?$/,
];

export function authHeaders(secret: { reveal(): string }): Record<string, string> {
  return { authorization: `Bearer ${secret.reveal()}` };
}

interface BasesResponse {
  bases: Array<{ id: string; name: string; permissionLevel?: string }>;
  offset?: string;
}

interface TablesResponse {
  tables: Array<{
    id: string;
    name: string;
    primaryFieldId?: string;
    fields?: Array<{ id: string; name: string; type: string }>;
  }>;
}

export async function crawl(ctx: ReadContext): Promise<CrawlResult> {
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];

  // Only the bases the org selected, when it selected any.
  const selected = Array.isArray(ctx.instance.config.bases)
    ? (ctx.instance.config.bases as string[])
    : null;

  let offset: string | undefined;
  const bases: Array<{ id: string; name: string }> = [];
  let pages = 0;

  do {
    const path = offset
      ? `/v0/meta/bases?offset=${encodeURIComponent(offset)}`
      : "/v0/meta/bases";
    const page = await ctx.http.getJson<BasesResponse>(path, ctx.signal);
    bases.push(...(page.bases ?? []));
    offset = page.offset;
    pages += 1;
  } while (offset && pages < 20);

  for (const base of bases) {
    if (selected && selected.length > 0 && !selected.includes(base.id)) continue;

    // node_kind has no `base` kind; ADR-recommended modelling is `service`.
    const baseKey = { connector: "airtable", externalId: `base/${base.id}` };
    nodes.push({
      key: baseKey,
      kind: "service",
      name: base.name,
      metadata: { airtableKind: "base" },
    });

    const tables = await ctx.http.getJson<TablesResponse>(
      `/v0/meta/bases/${base.id}/tables`,
      ctx.signal,
    );

    for (const table of tables.tables ?? []) {
      const tableKey = { connector: "airtable", externalId: `table/${table.id}` };
      nodes.push({
        key: tableKey,
        kind: "table",
        name: table.name,
        metadata: { baseId: base.id },
      });
      edges.push({
        src: tableKey,
        dst: baseKey,
        kind: "DERIVES_FROM",
        provenance: "static_parse",
      });

      for (const field of table.fields ?? []) {
        const fieldKey = { connector: "airtable", externalId: `field/${field.id}` };
        nodes.push({
          key: fieldKey,
          kind: "field",
          name: `${table.name}.${field.name}`,
          metadata: {
            fieldType: field.type,
            isComputed: COMPUTED_TYPES.has(field.type),
          },
        });
        edges.push({
          src: fieldKey,
          dst: tableKey,
          kind: "DERIVES_FROM",
          provenance: "static_parse",
        });
      }
    }
  }

  return { nodes, edges };
}

const COMPUTED_TYPES = new Set([
  "formula",
  "rollup",
  "count",
  "lookup",
  "autoNumber",
  "createdTime",
  "lastModifiedTime",
]);

export async function health(
  ctx: ReadContext,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const page = await ctx.http.getJson<BasesResponse>("/v0/meta/bases", ctx.signal);
    return { ok: true, detail: `${page.bases?.length ?? 0} bases visible` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export const airtableConnector: Connector = { descriptor, crawl, health };
