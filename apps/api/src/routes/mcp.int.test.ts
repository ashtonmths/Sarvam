import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "../auth/api-keys.js";
import { closePools, sql } from "../db.js";
import { onError } from "../http/middleware.js";
import {
  bodyGuard,
  corsMiddleware,
  DEFAULT_BODY_LIMIT_BYTES,
  securityHeaders,
} from "../http/security.js";
import { mcpRoutes } from "./mcp.js";

/**
 * The JSON-RPC envelope, the credential, and the capability check — the three
 * things every tool call passes through before any graph is touched.
 *
 * Against a real Postgres because the credential is a database fact: a revoked
 * key, a key belonging to another organisation and a key missing a scope are
 * all rows, and a mocked `verifyApiKey` would only prove the mock was told the
 * right answer.
 *
 * The transport is hand-rolled rather than the SDK's, which means the wire
 * format is this repository's responsibility: an id that does not come back,
 * or a tool failure raised as a transport error, breaks every client at once
 * and is invisible from the tool tests.
 */

function mcpApp() {
  // Mirrors how `index.ts` mounts it: outside the session group, carrying its
  // own auth, under the one error handler that shapes every response.
  const app = new Hono();
  app.onError(onError);
  app.route("/", mcpRoutes);
  return app;
}

/**
 * The same route with the edge middleware `index.ts` puts in front of it.
 * Separate from `mcpApp` so the protocol assertions stay about the protocol,
 * while the armor gets asserted where it is the subject.
 */
function edgeMountedApp() {
  const app = new Hono();
  app.use("*", securityHeaders);
  app.use("*", corsMiddleware);
  app.use("*", bodyGuard);
  app.onError(onError);
  app.route("/", mcpRoutes);
  return app;
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * The wire shape, declared once so no assertion has to widen `unknown`.
 *
 * `result` and `error` are declared as present because every assertion below
 * already knows which of the two it asked for; the tests that care assert the
 * other one is absent.
 */
interface RpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result: {
    protocolVersion: string;
    capabilities: unknown;
    serverInfo: unknown;
    tools: Array<{
      name: string;
      description: string;
      inputSchema: { type: string; required: string[] };
    }>;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError: boolean;
  };
  error: { code: number; message: string };
}

/** RFC 9457, which is what every rejection outside the envelope looks like. */
interface Problem {
  title: string;
  status: number;
  detail?: string;
}

async function post(
  body: Rpc | string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return mcpApp().request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The path-credential form, for the clients that cannot send a header. */
async function postWithKeyInPath(pathKey: string, body: Rpc): Promise<Response> {
  return mcpApp().request(`/mcp/k/${pathKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** POST and read the envelope back, which is what most assertions want. */
async function rpc(
  body: Rpc | string,
  headers: Record<string, string> = {},
): Promise<RpcResponse> {
  return (await (await post(body, headers)).json()) as RpcResponse;
}

async function problem(res: Response): Promise<Problem> {
  return (await res.json()) as Problem;
}

async function seedOrg(slug: string): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${slug}, ${slug}) RETURNING id
  `;
  return Number(row?.id);
}

async function seedUser(email: string): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash)
    VALUES (${email}, 'Test', 'scrypt$1$1$1$x$x') RETURNING id
  `;
  return Number(row?.id);
}

/** A live key with exactly the capabilities asked for. */
async function seedKey(orgId: number, scopes: string[]): Promise<string> {
  const created = await createApiKey({
    orgId,
    name: `key(${scopes.join(",") || "none"})`,
    scopes: scopes as never,
    createdBy: await seedUser(`u${Math.abs(orgId)}-${scopes.join("")}@example.com`),
  });
  return created.key;
}

const FULL_SCOPES = ["gate:invoke", "graph:read"];

let orgId: number;
let key: string;
let auth: Record<string, string>;

beforeEach(async () => {
  await sql`TRUNCATE organizations, users CASCADE`;
  orgId = await seedOrg("acme");
  key = await seedKey(orgId, FULL_SCOPES);
  auth = { authorization: `Bearer ${key}` };
});

afterAll(async () => {
  await closePools();
});

describe("authentication", () => {
  it("refuses a call with no credential at all", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await problem(res)).detail).toContain("MCP requires an API key");
  });

  it("refuses a key that is not one of ours before ever querying", async () => {
    // The prefix check is a free rejection: a bearer token from some other
    // system must not cost a database round trip.
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: "Bearer sk_live_definitely_not_ours" },
    );

    expect(res.status).toBe(401);
    expect((await problem(res)).detail).toContain("Invalid API key");
  });

  it("refuses a well-formed key that matches no row", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: "Bearer sadhak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    );

    expect(res.status).toBe(401);
  });

  it("accepts the credential in the Authorization header", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);

    expect(res.status).toBe(200);
  });

  it("accepts the credential in x-api-key, for clients that cannot set Authorization", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "x-api-key": key },
    );

    expect(res.status).toBe(200);
  });

  it("is case-insensitive about the Bearer scheme", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `bearer ${key}` },
    );

    expect(res.status).toBe(200);
  });

  it("refuses a revoked key", async () => {
    // Revocation is the only lever a customer has after a key leaks into a
    // model's context window. It has to bite on the very next call.
    await sql`UPDATE api_keys SET revoked_at = now()`;

    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);

    expect(res.status).toBe(401);
  });

  it("accepts the credential in the path, for a connector form with no header field", async () => {
    const res = await postWithKeyInPath(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(res.status).toBe(200);
  });

  it("refuses a key in the path that matches no row", async () => {
    const res = await postWithKeyInPath("sadhak_nothing-of-the-sort", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(res.status).toBe(401);
  });

  it("refuses a revoked key in the path too", async () => {
    // The path form puts the credential somewhere it gets logged, so it is the
    // one most likely to need revoking. Revocation has to reach it identically
    // — a second door that outlives the kill switch would be worse than no
    // second door.
    await sql`UPDATE api_keys SET revoked_at = now()`;

    const res = await postWithKeyInPath(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(res.status).toBe(401);
  });

  it("gives the path form the same scopes, not a way around them", async () => {
    // Same credential, same refusals. The URL is a transport detail; it must
    // not become a privilege.
    const res = await postWithKeyInPath(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ingest_document",
        arguments: { title: "Standup", text: "Priya: we shipped the gate." },
      },
    });
    const body = (await res.json()) as RpcResponse;

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("connector:manage");
  });

  it("checks the credential before reading the body, so a garbage payload cannot leak whether a method exists", async () => {
    const res = await post("not json at all");

    expect(res.status).toBe(401);
  });

  it("records that the key was used", async () => {
    await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);

    const [row] = await sql<{ last_used_at: Date | null }[]>`
      SELECT last_used_at FROM api_keys
    `;
    expect(row?.last_used_at).not.toBeNull();
  });
});

describe("initialize", () => {
  it("answers with the protocol version, capabilities and server identity", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claude-code", version: "1.0.0" },
        },
      },
      auth,
    );

    const body = (await res.json()) as RpcResponse;
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.serverInfo).toEqual({ name: "sadhak", version: "1.0.0" });
  });

  it("accepts the initialized notification without a body", async () => {
    // A notification has no id, so there is nothing to answer with. 202 is the
    // acknowledgement; a JSON body here makes strict clients complain.
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, auth);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("tools/list", () => {
  it("advertises exactly the five tools the product documents", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
    const body = (await res.json()) as RpcResponse;

    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "propose_change",
      "query_blast_radius",
      "get_node",
      "ask_docs",
      "ingest_document",
    ]);
  });

  it("tells the model, in the tool description, to transcribe an image itself", async () => {
    // The image contract lives in the description or it lives nowhere: the
    // connected agent decides what to send before this server sees anything,
    // and a tool that silently takes text is one an agent will hand a base64
    // blob to and then report success on.
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
    const body = (await res.json()) as RpcResponse;
    const ingest = body.result.tools.find(
      (t: { name: string }) => t.name === "ingest_document",
    );

    expect(ingest?.description).toContain("IMAGE");
    expect(ingest?.description).toContain("read it yourself");
    expect(ingest?.description).toContain('source="image"');
    expect(ingest?.description).toContain("never receives the image");
    // The instruction that keeps a transcription honest about its own gaps.
    expect(ingest?.description).toContain("[unclear]");
  });

  it("gives every tool a description and a JSON-Schema input", async () => {
    // The description is the only thing standing between the model and a
    // wrong tool choice, and the schema is the only thing standing between it
    // and a malformed call.
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
    const body = (await res.json()) as RpcResponse;

    for (const tool of body.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      expect(tool.inputSchema.required.length).toBeGreaterThan(0);
    }
  });

  it("tells the model, in the tool description, that a BLOCK is final", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
    const body = (await res.json()) as RpcResponse;
    const propose = body.result.tools.find(
      (t: { name: string }) => t.name === "propose_change",
    );

    expect(propose?.description).toContain("BLOCK");
    expect(propose?.description).toContain("must not be attempted");
  });

  it("lists the same tools a scope-less key would be refused at call time", async () => {
    // Listing is deliberately not gated: an agent that cannot see a tool
    // cannot be told why it may not use it. The refusal belongs at the call.
    const noScope = await seedKey(orgId, []);

    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer ${noScope}` },
    );

    expect(((await res.json()) as RpcResponse).result?.tools).toHaveLength(5);
  });
});

describe("the JSON-RPC envelope", () => {
  it("echoes a numeric id", async () => {
    const body = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }, auth);

    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(7);
  });

  it("echoes a string id", async () => {
    const body = await rpc({ jsonrpc: "2.0", id: "abc-1", method: "tools/list" }, auth);

    expect(body.id).toBe("abc-1");
  });

  it("echoes the id zero rather than collapsing it to null", async () => {
    // `id ?? null` is the reason this holds; `id || null` would break every
    // client that starts its counter at zero, and only on the first call.
    const body = await rpc({ jsonrpc: "2.0", id: 0, method: "tools/list" }, auth);

    expect(body.id).toBe(0);
  });

  it("answers a missing id with null", async () => {
    const body = await rpc({ jsonrpc: "2.0", method: "tools/list" }, auth);

    expect(body.id).toBeNull();
  });

  it("refuses an unknown method with -32601, not a broken connection", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "resources/list" }, auth);
    const body = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain("resources/list");
    expect(body.result).toBeUndefined();
  });

  it("rejects an envelope that is not JSON-RPC 2.0", async () => {
    const res = await post({ jsonrpc: "1.0", id: 1, method: "tools/list" } as Rpc, auth);

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("rejects an envelope with no method", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1 }, auth);

    expect(res.status).toBe(400);
  });

  it("refuses a stream probe with 405 — present, but not a stream", async () => {
    // Streamable HTTP allows a server-opened SSE channel on GET. This server is
    // stateless and does not offer one, and the spec's answer for that is 405.
    // It was 404 until a connector failed to finish connecting: "not found" is
    // grounds to conclude the URL is wrong and abandon a session that works
    // perfectly over POST, where "method not allowed" names the endpoint as
    // real and the method as the part that is not.
    const res = await mcpApp().request("/mcp", { method: "GET", headers: auth });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("refuses a session teardown the same way", async () => {
    // DELETE is how a client ends a session. Stateless: there is nothing to
    // end, but the endpoint is still there.
    const res = await mcpApp().request("/mcp", { method: "DELETE", headers: auth });

    expect(res.status).toBe(405);
  });

  it("answers the path-credential form identically", async () => {
    const res = await mcpApp().request("/mcp/k/whatever", { method: "GET" });

    expect(res.status).toBe(405);
  });
});

describe("capability enforcement", () => {
  it("refuses propose_change to a key without gate:invoke", async () => {
    const readOnly = await seedKey(orgId, ["graph:read"]);

    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "propose_change",
          arguments: {
            change: {
              target: "field",
              operation: "delete",
              connector: "postgres",
              externalId: "x",
            },
          },
        },
      },
      { authorization: `Bearer ${readOnly}` },
    );
    const body = (await res.json()) as RpcResponse;

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("gate:invoke");
  });

  it("refuses the read tools to a key without graph:read", async () => {
    const invokeOnly = await seedKey(orgId, ["gate:invoke"]);

    for (const name of ["query_blast_radius", "get_node"]) {
      const res = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { connector: "postgres", externalId: "x" } },
        },
        { authorization: `Bearer ${invokeOnly}` },
      );

      expect(((await res.json()) as RpcResponse).result?.content?.[0]?.text).toContain(
        "graph:read",
      );
    }
  });

  it("refuses ask_docs to a key without graph:read", async () => {
    // The scope check runs before the question is even parsed, so a key that
    // may not read the graph cannot use retrieval as a side door to the
    // documents describing it.
    const invokeOnly = await seedKey(orgId, ["gate:invoke"]);

    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ask_docs",
          arguments: { question: "why did we stop syncing vat_rate?" },
        },
      },
      { authorization: `Bearer ${invokeOnly}` },
    );
    const body = (await res.json()) as RpcResponse;

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("graph:read");
  });

  it("refuses ingest_document to a key that can only read", async () => {
    // The claim that separates the two document tools. `ask_docs` answers from
    // the corpus; this one writes to it, and a key handed to an agent for
    // questions must not be able to put words into the very corpus those
    // answers are drawn from. `graph:read` and `gate:invoke` together are
    // still not enough.
    const readOnly = await seedKey(orgId, ["graph:read", "gate:invoke"]);

    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ingest_document",
          arguments: { title: "Standup", text: "Priya: we shipped the gate." },
        },
      },
      { authorization: `Bearer ${readOnly}` },
    );
    const body = (await res.json()) as RpcResponse;

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("connector:manage");

    // And nothing was written on the way to being refused.
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM documents WHERE org_id = ${orgId}
    `;
    expect(row?.count).toBe("0");
  });

  it("reports a refusal as a tool error, not a transport error", async () => {
    // The distinction is the whole reason an agent can recover: a -32xxx looks
    // like a broken server and the client retries the connection, while an
    // `isError` result is text the model reads and acts on.
    const noScope = await seedKey(orgId, []);

    const res = await post(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "get_node",
          arguments: { connector: "postgres", externalId: "x" },
        },
      },
      { authorization: `Bearer ${noScope}` },
    );
    const body = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(body.id).toBe(9);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
  });

  it("refuses an unknown tool name as a tool error", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_everything", arguments: {} },
      },
      auth,
    );
    const body = (await res.json()) as RpcResponse;

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("Unknown tool: delete_everything");
  });

  it("reports malformed tool arguments as a tool error the model can fix", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_node", arguments: { connector: "salesforce" } },
      },
      auth,
    );

    expect(((await res.json()) as RpcResponse).result?.isError).toBe(true);
  });
});

/**
 * Behaviour that is real, reachable, and not what the surrounding design says
 * it should be. Pinned rather than left undescribed: each of these is a live
 * defect, and a test that fails the day one is fixed is the cheapest way to
 * make the fix visible.
 */
describe("known gaps", () => {
  const call = (args: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: {
      name: "propose_change",
      arguments: {
        change: {
          target: "field",
          operation: "delete",
          connector: "postgres",
          externalId: "acme/public/x/unmapped",
        },
        ...args,
      },
    },
  });

  it("GAP: a driver error reaches the caller with the SQL and the org id in it", async () => {
    // `tools/call` stringifies every thrown error into the tool result, which
    // is right for a UserError and wrong for anything else: the error taxonomy
    // exists so a non-exposed fault is logged and never serialized, and this
    // path bypasses it. A null byte in an id — legal JSON, and a model can
    // emit one — makes postgres reject the statement, and the reply carries
    // the generated query, the column list and the internal org id.
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_node",
          arguments: { connector: "postgres", externalId: "a\u0000b" },
        },
      },
      auth,
    );
    const text = ((await res.json()) as RpcResponse).result.content[0]?.text ?? "";

    expect(text).toContain("Failed query:");
    expect(text).toContain('from "nodes"');
    expect(text).toContain(String(orgId));
  });

  it("GAP: clientInfo from initialize never reaches the tool call it precedes", async () => {
    // The server is stateless, so the `ctx.clientName` assignment in the
    // `initialize` branch dies with that request. Only the non-standard
    // `x-mcp-client` header survives, and no MCP client sends it — so every
    // decision an agent makes is attributed to the placeholder, and the
    // decision log cannot tell Claude Code from Cursor from a shell script.
    await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "claude-code", version: "1.0.0" } },
      },
      auth,
    );
    await post(call(), auth);

    const [row] = await sql<{ actor: string }[]>`SELECT actor FROM gate_decisions`;
    expect(row?.actor).toBe("agent:mcp-client");
  });

  it("GAP: the x-mcp-client header is the only thing that names the agent", async () => {
    await post(call(), { ...auth, "x-mcp-client": "cursor" });

    const [row] = await sql<{ actor: string }[]>`SELECT actor FROM gate_decisions`;
    expect(row?.actor).toBe("agent:cursor");
  });

  it("GAP: Idempotency-Key is ignored, so a retrying agent double-writes the log", async () => {
    // `decide()` supports idempotency and the REST gate passes the header
    // through; the MCP route never reads it. Agents retry far more readily
    // than scripts do, so the door that most needs replay protection is the
    // one without it, and every retry inflates the enforcement count.
    const headers = { ...auth, "Idempotency-Key": "abc-123" };
    await post(call(), headers);
    await post(call(), headers);

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM gate_decisions
    `;
    expect(row?.n).toBe(2);
  });

  it("GAP: an agent's gate call leaves no audit_log entry", async () => {
    // The REST gate writes `gate.decision` and `gate.executed`. The MCP route
    // writes neither, so the audit log — the thing a customer exports when
    // asked to show who changed what — has no record that an agent asked at
    // all. The gate_decisions row exists, but it is a different table with a
    // different retention and a different export.
    await post(call(), auth);

    const rows = await sql<{ action: string }[]>`SELECT action FROM audit_log`;
    expect(rows).toEqual([]);
  });

  it("GAP: a malformed body is a 500, not a 400", async () => {
    // `c.req.json()` throws a SyntaxError, which is neither a ZodError nor an
    // AppError, so it falls through to the unhandled branch: logged at error,
    // shipped to Sentry, and reported to the caller as our fault. A client
    // that truncates a request can page someone.
    const res = await post("{ not json", auth);

    expect(res.status).toBe(500);
    expect((await problem(res)).title).toBe("Internal server error");
  });
});

describe("credential precedence and shape", () => {
  it("prefers x-api-key when both headers are present", async () => {
    // Two credentials on one request is ambiguous, and the route resolves it
    // by reading x-api-key first. Pinned because a silent flip would hand a
    // caller a different organisation's scope than the one it believes it sent.
    const other = await seedOrg("globex");
    const globexKey = await seedKey(other, FULL_SCOPES);

    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "x-api-key": globexKey, authorization: `Bearer ${key}` },
    );

    expect(res.status).toBe(200);
    const [used] = await sql<{ id: string }[]>`
      SELECT id FROM api_keys WHERE last_used_at IS NOT NULL
    `;
    const [globexRow] = await sql<{ id: string }[]>`
      SELECT id FROM api_keys WHERE org_id = ${other}
    `;
    expect(used?.id).toBe(globexRow?.id);
  });

  it("accepts a bare key in Authorization, without the Bearer scheme", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: key },
    );

    expect(res.status).toBe(200);
  });

  it("refuses an Authorization header carrying only the scheme", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: "Bearer " },
    );

    expect(res.status).toBe(401);
  });

  it("refuses an empty x-api-key rather than treating it as absent-but-fine", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "x-api-key": "" },
    );

    expect(res.status).toBe(401);
  });
});

describe("a successful tool call over the wire", () => {
  const nodeCall = {
    jsonrpc: "2.0" as const,
    id: 3,
    method: "tools/call",
    params: {
      name: "get_node",
      arguments: { connector: "postgres", externalId: "acme/vat" },
    },
  };

  beforeEach(async () => {
    await sql`
      INSERT INTO nodes (org_id, kind, name, external_id, connector, criticality)
      VALUES (${orgId}, 'field', 'vat', 'acme/vat', 'postgres', 0.4)
    `;
  });

  it("returns text content and structured content side by side", async () => {
    // Both halves matter and for different readers: the text is what the model
    // reasons over, the structured block is what a client renders. A client
    // that gets one without the other silently degrades.
    const body = await rpc(nodeCall, auth);

    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]?.type).toBe("text");
    expect(body.result.content[0]?.text.length).toBeGreaterThan(0);
    expect(body.result.structuredContent).toMatchObject({ found: true });
  });

  it("scopes the answer to the organisation the key belongs to, never to input", async () => {
    // The end-to-end version of tenant isolation: a real key, a real header,
    // an external id that exists — in the other organisation.
    const globexOrg = await seedOrg("globex");
    const globexKey = await seedKey(globexOrg, FULL_SCOPES);

    const body = await rpc(nodeCall, { authorization: `Bearer ${globexKey}` });

    expect(body.result.structuredContent).toMatchObject({ found: false });
  });
});

describe("the endpoint's method surface", () => {
  // GET and DELETE are part of the transport and answer 405; these are not
  // part of it at all, so there is nothing to say about them but 404.
  it.each(["PUT", "PATCH"])("does not answer %s", async (method) => {
    const res = await mcpApp().request("/mcp", { method, headers: auth });

    expect(res.status).toBe(404);
  });

  it("treats method names as case-sensitive, as JSON-RPC requires", async () => {
    const body = await rpc({ jsonrpc: "2.0", id: 1, method: "Tools/List" }, auth);

    expect(body.error.code).toBe(-32601);
  });

  it("refuses params that are not an object", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: ["get_node"] as never },
      auth,
    );

    expect(res.status).toBe(400);
  });

  it("refuses an id that is neither string nor number", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: true as never, method: "tools/list" },
      auth,
    );

    expect(res.status).toBe(400);
  });

  it("ignores unknown envelope fields rather than rejecting a forward-compatible client", async () => {
    const body = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list", _meta: { trace: "x" } } as never,
      auth,
    );

    expect(body.result.tools).toHaveLength(5);
  });

  it("treats tools/call with no params as a call to no tool", async () => {
    const body = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call" }, auth);

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("Unknown tool");
  });
});

describe("the edge middleware in front of it", () => {
  it("carries the API's security headers on an MCP response", async () => {
    const res = await edgeMountedApp().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("refuses an oversized body before the credential is ever read", async () => {
    // A 256 KB cap on a route whose largest legitimate body is a change
    // descriptor. The rejection has to be the API's problem shape, not Hono's
    // bare 413 text, or MCP becomes the one endpoint that errors differently.
    const huge = "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1);
    const res = await edgeMountedApp().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_node",
          arguments: { connector: "postgres", externalId: huge },
        },
      }),
    });

    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("hands a server-to-server caller no CORS grant, because it never asked for one", async () => {
    const res = await edgeMountedApp().request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        ...auth,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
