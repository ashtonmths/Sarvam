import { type Context, Hono } from "hono";
import { z } from "zod";
import { KEY_PREFIX, verifyApiKey } from "../auth/api-keys.js";
import { ForbiddenError, UnauthorizedError, UserError } from "../errors.js";
import {
  askDocs,
  askDocsInput,
  getNode,
  ingestDocument,
  ingestDocumentInput,
  type McpContext,
  nodeRefInput,
  proposeChange,
  proposeChangeInput,
  queryBlastRadius,
} from "../mcp/tools.js";
import { resolveAccessToken } from "./oauth.js";
import { issuer } from "./oauth-metadata.js";

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
  {
    /**
     * The write half of the document surface, and the only tool here that
     * takes prose rather than identifiers.
     *
     * Images are handled by *not* accepting them. The connected agent can
     * already read an image; this server cannot, and adding an OCR dependency
     * to do worse what the caller does natively would be the wrong seam. So
     * the contract is that the agent transcribes and this stores text — with
     * `source` recording which of the two happened, because a transcription is
     * not a copy and a reader who follows a citation into it deserves to know
     * that before quoting it back to anyone.
     */
    name: "ingest_document",
    description:
      'Store a meeting transcript, handover note or decision record in this organisation\'s document corpus so it becomes searchable and citable by ask_docs. Paste the text directly. If the user gives you an IMAGE of a transcript, whiteboard, slide or screenshot, read it yourself and pass the extracted text here with source="image" — this tool stores text only and never receives the image. Transcribe what is actually visible, keep speaker labels, and do not fill in anything you cannot read; write [unclear] instead. Ingesting is idempotent on exact content, so the same text stored twice writes nothing the second time.',
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            'What this document is, e.g. "Billing sync handover, 11 Mar" — shown in the document list and in every citation.',
        },
        text: {
          type: "string",
          description:
            'The full text. Keep "Speaker: line" turns on their own lines and VTT/SRT cues intact; chunking splits on those boundaries, and losing them costs per-speaker attribution in later citations.',
        },
        occurred_at: {
          type: "string",
          description:
            "ISO 8601 timestamp of when the meeting happened, if known. Not when it was ingested.",
        },
        source: {
          type: "string",
          enum: ["pasted_text", "image"],
          default: "pasted_text",
          description:
            'Where the text came from. Use "image" whenever you produced it by reading an image rather than copying text you were given — it is recorded on the document so later readers can weigh a transcription differently from a verbatim copy.',
        },
        original_name: {
          type: "string",
          description:
            "The source filename, if there was one. Text extensions only (.txt, .md, .vtt, .srt); omit it for a paste rather than inventing one.",
        },
        source_url: {
          type: "string",
          description:
            "Where the document came from, for provenance. Citations never point here.",
        },
      },
      required: ["title", "text"],
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

/**
 * What an unauthenticated caller is told to do next.
 *
 * A client that cannot set a header has no way to guess the OAuth flow exists;
 * this is the thread it pulls. Built lazily because `PUBLIC_API_URL` is
 * optional — a deployment without it still authenticates by API key, it simply
 * cannot offer OAuth, and a bare 401 is the honest answer there.
 */
function authChallenge(): string | undefined {
  try {
    return `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource"`;
  } catch {
    return undefined;
  }
}

async function contextFromApiKey(key: string): Promise<McpContext | null> {
  const actor = await verifyApiKey(key);
  if (!actor) return null;
  return { orgId: actor.orgId, apiKeyId: actor.keyId, scopes: actor.scopes };
}

async function contextFromOauthToken(token: string): Promise<McpContext | null> {
  const actor = await resolveAccessToken(token);
  if (!actor) return null;
  return { orgId: actor.orgId, scopes: actor.scopes };
}

async function serveMcp(c: Context, key: string | undefined) {
  if (!key) throw new UnauthorizedError("MCP requires an API key", authChallenge());

  // Two credential shapes, one context. An API key is the org's own, minted in
  // settings; an OAuth token belongs to a person who let a client act as them.
  // Both arrive as a bearer string and both reduce to `{ orgId, scopes }`, so
  // every capability check below is unaware of which one it is holding.
  const ctx = key.startsWith(KEY_PREFIX)
    ? await contextFromApiKey(key)
    : await contextFromOauthToken(key);
  if (!ctx) throw new UnauthorizedError("Invalid API key", authChallenge());

  const rpc = rpcSchema.parse(await c.req.json());

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
}

/** The header form. What a client that can set headers should always use. */
mcpRoutes.post("/mcp", (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  return serveMcp(c, c.req.header("x-api-key") ?? bearer);
});

/**
 * The same server, with the key in the path.
 *
 * Claude's "add custom connector" form takes a URL and an optional OAuth client
 * — there is no field for a static header — so a header-only server cannot be
 * added there at all. This carries the credential where such a client can put
 * it, and is a stopgap until the OAuth flow this protocol version actually
 * specifies exists.
 *
 * The cost is that the secret is now a URL: it lands in proxy and CDN logs,
 * in browser history, and in any screenshot of the connector settings, none of
 * which is true of a header. Treat a key pasted into a connector as published
 * the moment it is used — scope it to what that client needs and rotate it on
 * its own schedule rather than sharing one key with the header callers.
 */
mcpRoutes.post("/mcp/k/:key", (c) => serveMcp(c, c.req.param("key")));

/**
 * "We are here, we just do not do that" — which is a different answer from
 * "there is nothing here".
 *
 * Streamable HTTP lets a client open a server-to-client SSE stream with GET,
 * and terminate a session with DELETE. This server is stateless and pushes
 * nothing, so it supports neither; the spec's answer for that is 405, and it
 * says so precisely because a 404 tells a client the endpoint does not exist.
 * A client that probes for the stream and reads "not found" can reasonably
 * conclude it has the wrong URL and abandon a connection that would otherwise
 * have worked over POST alone.
 */
const methodNotAllowed = (c: Context) =>
  c.json(
    rpcError(null, -32601, "This server is stateless: use POST for every request."),
    405,
    { Allow: "POST" },
  );

mcpRoutes.get("/mcp", methodNotAllowed);
mcpRoutes.delete("/mcp", methodNotAllowed);
mcpRoutes.get("/mcp/k/:key", methodNotAllowed);
mcpRoutes.delete("/mcp/k/:key", methodNotAllowed);

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
    case "ingest_document": {
      // The same capability `POST /documents` requires: deciding what Sadhak
      // is allowed to read on the org's behalf. Deliberately not `graph:read`
      // — this is the one document tool that writes, and a key handed out for
      // questions must not be able to put words into the corpus those
      // questions are answered from.
      requireScope(ctx, "connector:manage");
      return ingestDocument(ctx, ingestDocumentInput.parse(args));
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
