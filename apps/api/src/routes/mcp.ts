import { type Context, Hono } from "hono";
import { z } from "zod";
import { KEY_PREFIX, verifyApiKey } from "../auth/api-keys.js";
import { AppError, UnauthorizedError } from "../errors.js";
import { registry } from "../mcp/catalog.js";
import { publish } from "../mcp/registry.js";
import type { McpContext } from "../mcp/tools.js";
import { resolveAccessToken } from "./oauth.js";
import { issuer } from "./oauth-metadata.js";

/**
 * MCP over Streamable HTTP, hand-rolled against the JSON-RPC wire format.
 *
 * Stateless (`sessionIdGenerator: undefined` in SDK terms) so there is no
 * session affinity to break behind a proxy today or under horizontal scale
 * later. Auth is the same API key the REST gate uses, and the key's org scopes
 * every query — no cross-tenant reads, ever.
 *
 * This file no longer describes the tools. It used to carry a hand-written
 * JSON Schema literal per tool alongside the zod schemas the handlers actually
 * parsed with, and the two had drifted — the published schema for `connector`
 * had lost its enum, and `change` was advertised as an object with no
 * properties. `mcp/catalog.ts` is now the single description and the wire
 * schema is generated from it, so a route that publishes something the handler
 * would reject is no longer expressible.
 */

export const mcpRoutes = new Hono();

/**
 * Newest first. A client asking for one of these gets exactly it; a client
 * asking for anything else is answered with the newest, which is what the spec
 * prescribes and is far kinder than refusing — the wire format across these
 * revisions is compatible for everything this server implements.
 */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/**
 * Shown to the agent once, at connection time, before it has called anything.
 *
 * Per-tool descriptions can only say what one tool does; they cannot say what
 * this server is for or which tool to reach for first. A model that has to
 * infer that from seven descriptions infers it differently every session — and
 * the ordering that matters most here (ask before you act) is precisely the one
 * a per-tool description cannot express.
 */
const INSTRUCTIONS = `Sadhak knows what this organisation's systems depend on, and why — from its dependency graph, its written record, its Slack, and its GitHub.

Two habits make this server worth having:

1. Before changing anything in a connected production system, call propose_change. It answers deterministically from the real dependency graph. A BLOCK verdict means the change must not be attempted by any route — relay that to your human rather than looking for another way around it.

2. Before answering a question about why this organisation does something, check whether it already answered it. ask_docs covers the written record, ask_slack covers the conversations, github_activity covers what actually shipped and what is failing. All three say plainly when they do not cover the question, and that is a real answer — it is much better than a plausible one you constructed yourself.

Every tool that retrieves something returns a link for each claim. Keep those links when you relay an answer: they are the only way the person reading you can check it.`;

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

/**
 * Who the calling client is, for the audit log.
 *
 * `initialize` carries a proper `clientInfo.name`, and on a stateless server
 * there is nowhere to keep it — the next request is a new context. So the
 * header is what actually identifies the client on the call that matters, and
 * the User-Agent is the fallback for the clients that set neither. Writing the
 * `initialize` value onto a context that is discarded a line later, as this
 * previously did, produced an audit trail that recorded "an MCP client" for
 * every agent that had politely introduced itself.
 */
function clientNameFrom(c: Context): string | undefined {
  return c.req.header("x-mcp-client") ?? c.req.header("user-agent") ?? undefined;
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

  /**
   * The spec requires a 400 for a protocol version this server does not speak,
   * rather than an attempt to serve it anyway. Absent is not an error: the
   * header was introduced after the first revision, so a client that omits it
   * is an older client, not a broken one.
   */
  const declared = c.req.header("mcp-protocol-version");
  if (
    declared &&
    !SUPPORTED_PROTOCOLS.includes(declared as (typeof SUPPORTED_PROTOCOLS)[number])
  ) {
    return c.json(
      rpcError(
        null,
        -32600,
        `Unsupported MCP-Protocol-Version "${declared}". This server speaks ${SUPPORTED_PROTOCOLS.join(", ")}.`,
      ),
      400,
    );
  }

  const rpc = rpcSchema.parse(await c.req.json());

  /**
   * A JSON-RPC notification has no id and must never be answered with a body —
   * a client that receives one for a notification it did not expect a reply to
   * can desynchronise. Matching on the prefix rather than on
   * `notifications/initialized` alone means a client sending `cancelled` or
   * `progress` gets the same correct silence instead of an error.
   */
  if (rpc.method.startsWith("notifications/")) return c.body(null, 202);

  switch (rpc.method) {
    case "initialize": {
      const asked = rpc.params?.protocolVersion;
      const agreed =
        typeof asked === "string" &&
        SUPPORTED_PROTOCOLS.includes(asked as (typeof SUPPORTED_PROTOCOLS)[number])
          ? asked
          : LATEST_PROTOCOL;

      return c.json(
        result(rpc.id, {
          protocolVersion: agreed,
          capabilities: {
            // `listChanged: false` stated rather than omitted: this server is
            // stateless and pushes nothing, so a client must not wait for a
            // notification that will never arrive.
            tools: { listChanged: false },
          },
          serverInfo: { name: "sadhak", title: "Sadhak", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        }),
      );
    }

    /** Required by the spec as a liveness check, and cheap to answer honestly. */
    case "ping":
      return c.json(result(rpc.id, {}));

    case "tools/list":
      /**
       * Only the tools this credential can actually call.
       *
       * Advertising all of them was worse than it looks. A key holding just
       * `graph:read` was shown `ingest_document`, and a model told a capability
       * exists will use it — then read a 403, and now has to decide whether the
       * failure was transient. Some retry; some abandon the whole task. Not
       * listing it means the capability never enters the plan.
       */
      return c.json(result(rpc.id, { tools: registry.visibleTo(ctx).map(publish) }));

    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = rpc.params?.arguments ?? {};
      const callCtx: McpContext = { ...ctx, clientName: clientNameFrom(c) };

      try {
        const outcome = await registry.call(name, args, callCtx);
        return c.json(
          result(rpc.id, {
            content: [{ type: "text", text: outcome.text }],
            structuredContent: outcome.structured,
            isError: false,
          }),
        );
      } catch (error) {
        /**
         * Tool errors are results, not transport errors — the agent needs to
         * read them and adapt, not see a broken connection.
         *
         * Only an `AppError` is relayed verbatim. Those messages are written
         * for the caller and say what to do next; anything else is an
         * unexpected fault whose message may carry internals, and the agent can
         * do nothing useful with a stack-shaped string either way.
         */
        const message =
          error instanceof AppError && error.expose
            ? error.message
            : `${name} failed for an unexpected reason on the server. Nothing changed. Do not retry immediately; report this to your human.`;

        return c.json(
          result(rpc.id, {
            content: [{ type: "text", text: message }],
            isError: true,
          }),
        );
      }
    }

    default:
      return c.json(
        rpcError(
          rpc.id,
          -32601,
          `Unknown method: ${rpc.method}. This server implements initialize, ping, tools/list and tools/call.`,
        ),
      );
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
