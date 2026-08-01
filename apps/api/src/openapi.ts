import { changeDescriptorSchema } from "@sadhak/shared/types";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "./config.js";
import { signinSchema, signupSchema } from "./routes/auth.js";

/**
 * The OpenAPI document, assembled from the zod schemas the routes actually
 * validate with.
 *
 * That sourcing is the whole point. A hand-written spec is fiction by the
 * second release — someone adds a field, the handler accepts it, the document
 * does not mention it, and a caller finds out at runtime. Every request body
 * below is `zodToJsonSchema(<the same object the handler parses with>)`, so the
 * two cannot disagree without the build changing.
 *
 * **Not `hono-openapi`.** Plan 18.3 names it, and it would mean decorating
 * every route with `describeRoute` middleware — a change to seventy-odd
 * handlers to produce a document this file produces by importing the schemas
 * that already exist. The property the plan wanted is "derived from the zod the
 * routes validate with", and that is satisfied here directly. What is given up
 * is per-route prose living beside each handler; what is avoided is a
 * seventy-file diff whose only purpose is documentation.
 *
 * The honest limit, stated because a reference that overclaims is the thing
 * this file exists to prevent: **response** schemas are described by shape
 * rather than derived, because responses are assembled in handlers rather than
 * parsed through a zod object. Request bodies — the half a caller can get wrong
 * — are derived. `pnpm check:openapi` fails if the committed document drifts
 * from what this file generates.
 */

function json(schema: ZodTypeAny) {
  const generated = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
  // The generator emits a JSON Schema dialect marker OpenAPI 3.0 rejects.
  const { $schema, ...rest } = generated as Record<string, unknown>;
  return rest;
}

const PROBLEM = {
  type: "object",
  description: "RFC 9457 problem details. Served as application/problem+json.",
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    requestId: { type: "string" },
  },
  required: ["type", "title", "status", "instance", "requestId"],
} as const;

function problemResponse(description: string) {
  return {
    description,
    content: {
      "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
    },
  };
}

const CURSOR_PAGE = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "object" } },
    nextCursor: {
      type: "string",
      nullable: true,
      description:
        "Opaque. Absent or null on the last page. A tampered cursor is a 400, never a 500.",
    },
  },
  required: ["items"],
} as const;

const LIMIT_PARAM = {
  name: "limit",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  description: "Outside 1–200 is a 400, never a silent clamp.",
} as const;

const CURSOR_PARAM = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string" },
  description: "From a previous response's nextCursor.",
} as const;

function listOperation(summary: string, tag: string, capability?: string) {
  return {
    summary,
    tags: [tag],
    ...(capability ? { description: `Requires the \`${capability}\` capability.` } : {}),
    parameters: [LIMIT_PARAM, CURSOR_PARAM],
    responses: {
      "200": {
        description: "A page of results.",
        content: { "application/json": { schema: CURSOR_PAGE } },
      },
      "401": problemResponse("No credential, or one that no longer resolves."),
      "403": problemResponse("Authenticated, but without the capability."),
    },
  };
}

export function openapiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Sadhak API",
      version: config.GIT_SHA ?? "dev",
      description: [
        "Sadhak keeps a dependency graph of your systems and gates the changes",
        "that would break them.",
        "",
        "**Verdicts are deterministic.** The same change against the same graph",
        "returns the same answer, every time, with no model in the path. An edge",
        "a model inferred can raise a warning and can never produce a BLOCK.",
        "",
        "**Tenancy is resolved from the credential, never from input.** Every",
        "org-scoped route also answers at `/api/orgs/{orgId}/…`, where `{orgId}`",
        "is *asserted* against the org your credential resolved to — a mismatch",
        "is a **404, not a 403**, so a wrong org id is indistinguishable from one",
        "that does not exist.",
      ].join("\n"),
    },
    servers: [{ url: "https://api.sadhak.online", description: "Production" }],
    tags: [
      { name: "Auth", description: "Sessions and org membership." },
      {
        name: "Gate",
        description: "Ask for a verdict, or forward a change through one.",
      },
      { name: "Graph", description: "The map: nodes, edges, and what is unresolved." },
      {
        name: "Rationale",
        description: "Why a dependency exists, and who confirmed it.",
      },
      { name: "Reflex", description: "Detected changes and their reverts." },
      { name: "Org", description: "Members, keys, audit, export and erasure." },
    ],
    components: {
      schemas: {
        Problem: PROBLEM,
        ChangeDescriptor: json(changeDescriptorSchema),
        SignUp: json(signupSchema),
        SignIn: json(signinSchema),
      },
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description:
            "An org-scoped key, `sadhak_…`. Also accepted as `Authorization: Bearer`. A key can never hold more capability than the person who created it.",
        },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "sadhak_session",
          description: "What the web app uses. Set by POST /api/auth/signin.",
        },
      },
    },
    security: [{ apiKey: [] }, { session: [] }],
    paths: {
      "/api/auth/signup": {
        post: {
          summary: "Create an account and its first organisation",
          tags: ["Auth"],
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SignUp" } },
            },
          },
          responses: {
            "200": { description: "Created. Sets the session cookie." },
            "400": problemResponse("Validation failed."),
            "409": problemResponse("That email already has an account."),
            "429": problemResponse("Rate limited. Carries Retry-After."),
          },
        },
      },
      "/api/auth/signin": {
        post: {
          summary: "Start a session",
          tags: ["Auth"],
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SignIn" } },
            },
          },
          responses: {
            "200": { description: "Signed in. Sets the session cookie." },
            "401": problemResponse(
              "Wrong email or password — the two are not distinguished.",
            ),
            "429": problemResponse(
              "Rate limited. Ten a minute, because that is where guessing a password becomes worth someone's time.",
            ),
          },
        },
      },
      "/api/auth/me": {
        get: {
          summary: "The current user, their orgs, and their capabilities",
          tags: ["Auth"],
          responses: {
            "200": { description: "The session's identity and what it may do." },
            "401": problemResponse("No session."),
          },
        },
      },
      "/api/verdicts": {
        post: {
          summary: "Ask the gate about a change",
          tags: ["Gate"],
          description: [
            "Requires `gate:invoke`. Evaluates the change and returns the verdict",
            "with the evidence behind it. **Nothing is forwarded** — this is the",
            "question, not the action. Use the forward route for that, and note",
            "it needs a different capability: an agent that may ask is not",
            "necessarily an agent that may act.",
          ].join("\n"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChangeDescriptor" },
              },
            },
          },
          responses: {
            "200": {
              description:
                "The verdict, its evidence, and the blast radius that produced it.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      verdict: { type: "string", enum: ["APPROVE", "WARN", "BLOCK"] },
                      evidence: { type: "array", items: { type: "object" } },
                    },
                    required: ["id", "verdict"],
                  },
                },
              },
            },
            "400": problemResponse("The change descriptor did not validate."),
            "401": problemResponse("No credential."),
            "403": problemResponse("Credential lacks gate:invoke."),
            "404": problemResponse("The target node does not exist in your org's graph."),
          },
        },
      },
      "/api/verdicts/{id}": {
        get: {
          summary: "Re-read a verdict",
          tags: ["Gate"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": { description: "The verdict as it was issued, not recomputed." },
            "404": problemResponse("No such verdict in your org."),
          },
        },
      },
      "/api/verdicts/{id}/explanation": {
        get: {
          summary: "Prose explaining a verdict",
          tags: ["Gate"],
          description:
            "Generated by a model, and therefore optional. When the model is unavailable or the daily quota is spent this returns no prose — the verdict and its evidence are unaffected, because they never touched a model.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": { description: "The explanation, or an empty one." },
            "404": problemResponse("No such verdict in your org."),
          },
        },
      },
      "/api/graph/nodes": { get: listOperation("List nodes", "Graph", "graph:read") },
      "/api/graph/edges": { get: listOperation("List edges", "Graph", "graph:read") },
      "/api/graph/stats": {
        get: {
          summary: "Counts by kind, connector and state",
          tags: ["Graph"],
          responses: { "200": { description: "What the map is made of." } },
        },
      },
      "/api/graph/unresolved": {
        get: {
          ...listOperation("References we refused to guess at", "Graph", "graph:read"),
          description:
            "Things a crawl saw referenced but could not resolve. Shown rather than guessed, because a wrong edge is worse than a missing one.",
        },
      },
      "/api/rationale": {
        get: listOperation("List rationale", "Rationale", "graph:read"),
      },
      "/api/incidents": {
        get: listOperation("List detected changes", "Reflex", "graph:read"),
      },
      "/api/audit": { get: listOperation("The audit log", "Org", "audit:read") },
      "/api/org/export": {
        get: {
          summary: "Export everything this organisation has",
          tags: ["Org"],
          description: [
            "Requires `org:delete`, which only an owner holds. One JSON document:",
            "graph, rationale, verdicts, decisions, incidents and the audit log.",
            "",
            "Credentials are excluded — they are sealed to this org and connector",
            "and would not work anywhere else. Embeddings are excluded because",
            "they are derived from text already in the file.",
          ].join("\n"),
          responses: {
            "200": {
              description: "The export, as a file attachment.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "403": problemResponse("Not an owner."),
          },
        },
      },
      "/api/org": {
        delete: {
          summary: "Delete this organisation and everything in it",
          tags: ["Org"],
          description:
            "Irreversible. Cascades at the database — graph, rationale, verdicts, credentials and audit log. There is no grace period and no soft delete, because a window during which we still hold everything is a retention policy wearing a deletion policy's name.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    confirmName: {
                      type: "string",
                      description: "The organisation's name, typed exactly.",
                    },
                  },
                  required: ["confirmName"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Deleted." },
            "400": problemResponse(
              "The confirmation name did not match. Nothing was deleted.",
            ),
            "403": problemResponse("Not an owner."),
          },
        },
      },
    },
  };
}
