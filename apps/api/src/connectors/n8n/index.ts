import type {
  Connector,
  ConnectorDescriptor,
  CrawlResult,
  EdgeSpec,
  ExternalRef,
  NodeSpec,
  ReadContext,
} from "../types.js";

/**
 * n8n's public REST API. The instance is already running — dev compose on
 * :5678, production at n8n.sadhak.online — so this parser is written against
 * responses the real thing returns, never against a guess from the docs.
 */

export const descriptor: ConnectorDescriptor = {
  slug: "n8n",
  displayName: "n8n",
  auth: "api_key",
  readScopes: [
    {
      scope: "GET /api/v1/workflows",
      purpose:
        "Read workflow structure: nodes, connections and the credential ids they reference.",
    },
  ],
  writeScopes: [
    {
      scope: "PATCH /api/v1/workflows/:id",
      purpose:
        "Restore a previous workflow version during a Reflex revert. Granted separately.",
    },
  ],
  webhooks: true,
  revertible: true,
  crawls: true,
};

/** Only the workflow list. The record/execution-data endpoints are not here. */
export const ALLOWED_PATHS = [/^\/api\/v1\/workflows(\?.*)?$/];

export function authHeaders(secret: { reveal(): string }): Record<string, string> {
  return { "X-N8N-API-KEY": secret.reveal() };
}

interface N8nCredentialRef {
  id?: string;
  name?: string;
}

interface N8nNode {
  id?: string;
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, N8nCredentialRef>;
}

interface N8nWorkflow {
  id: string;
  name: string;
  active?: boolean;
  updatedAt?: string;
  nodes?: N8nNode[];
  /** Keyed by node *name*, not id — n8n's own quirk. */
  connections?: Record<
    string,
    Record<string, Array<Array<{ node: string; type?: string; index?: number }>>>
  >;
}

interface WorkflowPage {
  data: N8nWorkflow[];
  nextCursor?: string | null;
}

export async function crawl(ctx: ReadContext): Promise<CrawlResult> {
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];

  let cursor: string | null | undefined;
  let pages = 0;

  do {
    const path = cursor
      ? `/api/v1/workflows?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "/api/v1/workflows?limit=100";
    const page = await ctx.http.getJson<WorkflowPage>(path, ctx.signal);

    for (const workflow of page.data ?? []) {
      parseWorkflow(workflow, nodes, edges);
    }

    cursor = page.nextCursor ?? null;
    pages += 1;
  } while (cursor && pages < 50);

  return { nodes, edges };
}

function parseWorkflow(
  workflow: N8nWorkflow,
  nodes: NodeSpec[],
  edges: EdgeSpec[],
): void {
  const workflowKey = { connector: "n8n", externalId: `workflow/${workflow.id}` };

  nodes.push({
    key: workflowKey,
    kind: "workflow",
    name: workflow.name,
    metadata: {
      active: workflow.active ?? false,
      ...(workflow.updatedAt ? { updatedAt: workflow.updatedAt } : {}),
    },
  });

  /** n8n keys `connections` by node name, so we need name → id. */
  const idByName = new Map<string, string>();
  for (const node of workflow.nodes ?? []) {
    idByName.set(node.name, node.id ?? node.name);
  }

  for (const node of workflow.nodes ?? []) {
    const nodeId = node.id ?? node.name;
    const stepKey = {
      connector: "n8n",
      externalId: `workflow/${workflow.id}/node/${nodeId}`,
    };

    nodes.push({
      key: stepKey,
      kind: "step",
      name: node.name,
      metadata: {
        nodeType: node.type,
        idStrategy: node.id ? "uuid" : "name",
      },
    });

    edges.push({
      src: workflowKey,
      dst: stepKey,
      kind: "DERIVES_FROM",
      provenance: "static_parse",
    });

    // Credentials: the public API cannot list them, so derive from the blocks
    // embedded in workflow nodes. id + name is structure, and all we want.
    for (const [credType, ref] of Object.entries(node.credentials ?? {})) {
      if (!ref?.id) continue;
      const credKey = { connector: "n8n", externalId: `credential/${ref.id}` };
      nodes.push({
        key: credKey,
        kind: "credential",
        name: ref.name ?? `${credType} credential`,
        metadata: { credentialType: credType },
      });
      edges.push({
        src: stepKey,
        dst: credKey,
        kind: "AUTHENTICATES_WITH",
        provenance: "static_parse",
      });
    }

    // Typed steps carry the vendor ids that make cross-connector fusion exact.
    for (const ref of externalRefsOf(node)) {
      edges.push({
        src: stepKey,
        dst: ref.ref,
        kind: ref.writes ? "WRITES_TO" : "READS_FROM",
        provenance: "static_parse",
      });
    }
  }

  // `connections` maps producer → consumers; a consumer runs *because* the
  // producer fired, so the dependent is the consumer: consumer → producer.
  for (const [producerName, outputs] of Object.entries(workflow.connections ?? {})) {
    const producerId = idByName.get(producerName);
    if (!producerId) continue;

    for (const branches of Object.values(outputs)) {
      for (const branch of branches ?? []) {
        for (const link of branch ?? []) {
          const consumerId = idByName.get(link.node);
          if (!consumerId) continue;
          edges.push({
            src: {
              connector: "n8n",
              externalId: `workflow/${workflow.id}/node/${consumerId}`,
            },
            dst: {
              connector: "n8n",
              externalId: `workflow/${workflow.id}/node/${producerId}`,
            },
            kind: "TRIGGERS",
            provenance: "static_parse",
          });
        }
      }
    }
  }
}

/** What a typed step touches, as a reference the resolver can canonicalize. */
export function externalRefsOf(
  node: N8nNode,
): Array<{ ref: ExternalRef; writes: boolean }> {
  const params = node.parameters ?? {};
  const type = node.type.toLowerCase();
  const refs: Array<{ ref: ExternalRef; writes: boolean }> = [];
  const operation = String(params.operation ?? "").toLowerCase();
  const writes = /create|update|upsert|append|delete|insert|write/.test(operation);

  if (type.includes("airtable")) {
    const baseId = idFrom(params.base ?? params.application ?? params.baseId);
    const tableId = idFrom(params.table ?? params.tableId);
    if (baseId || tableId) {
      refs.push({
        ref: {
          system: "airtable",
          ...(baseId ? { baseId } : {}),
          ...(tableId?.startsWith("tbl") ? { tableId } : {}),
          ...(tableId && !tableId.startsWith("tbl") ? { tableName: tableId } : {}),
        },
        writes,
      });
    }
  }

  if (type.includes("postgres")) {
    const table = stringFrom(params.table);
    if (table) {
      const schema = stringFrom(params.schema) ?? "public";
      refs.push({ ref: { system: "postgres", schema, table }, writes });
    }
  }

  if (type.includes("httprequest")) {
    const url = stringFrom(params.url);
    if (url) {
      try {
        // Query strings can carry customer data. Host and path only, always.
        const parsed = new URL(url);
        refs.push({
          ref: { system: "http", host: parsed.host, path: parsed.pathname },
          writes,
        });
      } catch {
        /* a templated URL we cannot parse is not a reference we can trust */
      }
    }
  }

  return refs;
}

/** n8n resource locators are sometimes `{ value, mode }`, sometimes a string. */
function idFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "string" && inner ? inner : undefined;
  }
  return undefined;
}

function stringFrom(value: unknown): string | undefined {
  const resolved = idFrom(value);
  return resolved;
}

export async function health(
  ctx: ReadContext,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await ctx.http.getJson<WorkflowPage>("/api/v1/workflows?limit=1", ctx.signal);
    return { ok: true, detail: "n8n API reachable" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export const n8nConnector: Connector = { descriptor, crawl, health };
