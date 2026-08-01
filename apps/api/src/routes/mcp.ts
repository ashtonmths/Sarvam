import { Hono } from "hono";
import { z } from "zod";
import { verifyApiKey } from "../auth/api-keys.js";
import { ForbiddenError, UnauthorizedError, UserError } from "../errors.js";
import {
  askDocs,
  askDocsInput,
  getNode,
  type McpContext,
  nodeRefInput,
  proposeChange,
  proposeChangeInput,
  queryBlastRadius,
} from "../mcp/tools.js";

/**
 * MCP over Streamable HTTP, hand-rolled against the JSON-RPC wire format.
 *
 * Stateless (`sessionIdGenerator: undefined` in SDK terms) so there is no
 * session affinity to break behind a proxy today or under horizontal scale
 * later. Auth is the same API key the REST gate uses, and the key's org scopes
 * every query — no cross-tenant reads, ever.
 */

export const mcpRoutes = new Hono();

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "propose_change",
    description:
      "Ask permission before mutating a connected production system. Returns a deterministic verdict with evidence. A BLOCK means the change must not be attempted.",
    inputSchema: {
      type: "object",
      properties: {
        change: {
          type: "object",
          description:
            "The proposed change: { target: 'field'|'workflow'|'credential', operation, connector, externalId }",
        },
        dry_run: { type: "boolean", default: false },
      },
      required: ["change"],
    },
  },
  {
    name: "query_blast_radius",
    description:
      "Ask what depends on a node, without proposing anything. Read-only; records no decision.",
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string" },
        externalId: { type: "string" },
      },
      required: ["connector", "externalId"],
    },
  },
  {
    name: "get_node",
    description:
      "Fetch a node with its criticality, direct edges and confirmed rationale.",
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string" },
        externalId: { type: "string" },
      },
      required: ["connector", "externalId"],
    },
  },
  {
    // The other three tools need an exact node identifier, which is the wrong
    // shape for "why did we do it this way" — the questions whose answer is in
    // a meeting note nobody can name. This one takes the question itself.
    name: "ask_docs",
    description:
      "Ask a question in plain English about this organisation's decisions, systems and history, and get an answer drawn only from its own documents — meeting notes, transcripts and handovers — with a citation link for every claim. Use this when you need context you do not have, when you need to know why something is the way it is, or before assuming an answer. Says so plainly when the documents do not cover it; treat that as the answer rather than filling the gap yourself.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            'A specific question in prose, e.g. "why did we stop syncing the vat_rate field?". Retrieval is hybrid lexical and semantic, so exact identifiers and descriptions of them both work.',
        },
      },
      required: ["question"],
    },
  },
];

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result: value };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

mcpRoutes.post("/mcp", async (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const key = c.req.header("x-api-key") ?? bearer;
  if (!key) throw new UnauthorizedError("MCP requires an API key");

  const actor = await verifyApiKey(key);
  if (!actor) throw new UnauthorizedError("Invalid API key");

  const rpc = rpcSchema.parse(await c.req.json());
  const ctx: McpContext = {
    orgId: actor.orgId,
    apiKeyId: actor.keyId,
    scopes: actor.scopes,
  };

  switch (rpc.method) {
    case "initialize": {
      const clientName = (rpc.params?.clientInfo as { name?: string } | undefined)?.name;
      ctx.clientName = clientName;
      return c.json(
        result(rpc.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "sadhak", version: "1.0.0" },
        }),
      );
    }

    case "notifications/initialized":
      return c.body(null, 202);

    case "tools/list":
      return c.json(result(rpc.id, { tools: TOOLS }));

    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      const clientName = c.req.header("x-mcp-client") ?? undefined;
      const callCtx: McpContext = { ...ctx, clientName };

      try {
        const outcome = await callTool(name, args, callCtx);
        return c.json(
          result(rpc.id, {
            content: [{ type: "text", text: outcome.text }],
            structuredContent: outcome.structured,
            isError: false,
          }),
        );
      } catch (error) {
        // Tool errors are results, not transport errors — the agent needs to
        // read them and adapt, not see a broken connection.
        const message = error instanceof Error ? error.message : String(error);
        return c.json(
          result(rpc.id, {
            content: [{ type: "text", text: message }],
            isError: true,
          }),
        );
      }
    }

    default:
      return c.json(rpcError(rpc.id, -32601, `Unknown method: ${rpc.method}`));
  }
});

async function callTool(name: string, args: Record<string, unknown>, ctx: McpContext) {
  switch (name) {
    case "propose_change": {
      requireScope(ctx, "gate:invoke");
      return proposeChange(ctx, proposeChangeInput.parse(args));
    }
    case "query_blast_radius": {
      requireScope(ctx, "graph:read");
      return queryBlastRadius(ctx, nodeRefInput.parse(args));
    }
    case "get_node": {
      requireScope(ctx, "graph:read");
      return getNode(ctx, nodeRefInput.parse(args));
    }
    case "ask_docs": {
      // The same capability `POST /ask` requires, and for the same reason: it
      // answers only from chunks a `graph:read` caller could already open by
      // hand, and every claim carries the link to do so.
      requireScope(ctx, "graph:read");
      return askDocs(ctx, askDocsInput.parse(args));
    }
    default:
      throw new UserError(`Unknown tool: ${name}`);
  }
}

function requireScope(ctx: McpContext, scope: string): void {
  if (!ctx.scopes.includes(scope)) {
    throw new ForbiddenError(`This API key lacks the "${scope}" capability`);
  }
}
