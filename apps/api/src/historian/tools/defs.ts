import { z } from "zod";
import type { ToolDef } from "../../llm.js";

/**
 * The tools carry the security posture: **the model chooses queries; the tool
 * implementation injects scope.** Historian reads only the channels and repos
 * an org explicitly selected, and no tool parameter can widen that.
 *
 * Boundary, stated so it survives contributors: tools return message and PR
 * *text*, which is what rationale is. `get_edge_context` never queries a
 * customer data system — only the graph. Nothing here reads a table row.
 */

export const TOOL_NAMES = [
  "get_edge_context",
  "search_slack",
  "search_github",
  "read_thread",
  "propose_rationale",
  "give_up",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const toolArgSchemas = {
  get_edge_context: z.object({}),
  search_slack: z.object({ query: z.string().min(1).max(300) }),
  search_github: z.object({
    query: z.string().min(1).max(300),
    kind: z.enum(["pr", "commit"]).default("pr"),
  }),
  read_thread: z.object({ permalink: z.string().url() }),
  propose_rationale: z.object({
    text: z.string().min(10).max(1000),
    source_url: z.string().url(),
    author: z.string().min(1).max(200),
    /**
     * When the words were written, from the `authored_at` the search tool
     * returned. Mined rationale had no timestamp at all because there was
     * nowhere in this schema to put one, so the review queue ordered a 2023
     * decision as though it happened today. Optional, because a source that
     * cannot tell us stays honestly null rather than borrowing crawl time.
     */
    authored_at: z.string().datetime({ offset: true }).optional(),
    confidence: z.number().min(0).max(1).default(0.7),
  }),
  give_up: z.object({ reason: z.string().min(3).max(300) }),
} as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_edge_context",
      description:
        "Get the two nodes this edge connects, their kinds and criticality, the edge's provenance, their owners, and any rationale already linked. Call this first.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_slack",
      description:
        "Search the org's selected Slack channels for messages. Returns snippets with permalinks. You may only cite permalinks returned by a tool.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_github",
      description:
        "Search the org's selected GitHub repos for pull requests or commits. Returns snippets with URLs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["pr", "commit"] },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_thread",
      description:
        "Read the full thread or PR discussion behind a permalink you already retrieved this run.",
      parameters: {
        type: "object",
        properties: { permalink: { type: "string" } },
        required: ["permalink"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_rationale",
      description:
        "Terminal. Propose the explanation as a verbatim quoted span plus the permalink you retrieved it from. The span must appear in that source.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          source_url: { type: "string" },
          author: { type: "string" },
          authored_at: {
            type: "string",
            description:
              "The authored_at the search or thread tool gave for this message, copied verbatim. Omit it if the tool did not return one. Never invent it.",
          },
          confidence: { type: "number" },
        },
        required: ["text", "source_url", "author"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "give_up",
      description:
        "Terminal. Use this when no written trace explains the edge. An honest 'unexplained' is correct and expected — never invent a reason.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
];

/**
 * The structured-output envelope. Primary protocol, because small models call
 * functions materially less reliably than frontier models — `tools` still goes
 * on the request so a frontier model configured later uses its native path
 * with zero code change.
 */
export const TOOL_ENVELOPE = {
  type: "json_schema",
  json_schema: {
    name: "tool_call",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tool: { type: "string", enum: [...TOOL_NAMES] },
        args: { type: "object" },
      },
      required: ["tool", "args"],
    },
  },
} as const;

export const HISTORIAN_PROMPT = `You are Historian. You investigate why a dependency exists in an operations graph, using only written evidence you can cite.

Reply with exactly one JSON object and nothing else — no prose, no code fences:
  {"tool": "<tool name>", "args": { ... }}

Rules:
- Call get_edge_context first.
- Search before you conclude. Quote spans verbatim; never paraphrase into a citation.
- You may only cite a source_url that a tool returned to you in this run.
- The quoted text must actually appear in that source.
- If no written trace explains the edge, call give_up with the reason. That is a correct, expected answer — an honest "unexplained" is far more valuable than a plausible guess.
- Never invent a URL, an author, or a quote.`;
