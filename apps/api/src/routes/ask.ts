import { Hono } from "hono";
import { z } from "zod";
import { askDocuments } from "../documents/ask.js";
import { requireCapability } from "../middleware/auth.js";

export const askRoutes = new Hono();

/**
 * Ask a question in prose, get an answer grounded in this org's own documents.
 *
 * `graph:read`, deliberately the same capability as reading a node. This adds
 * no reach: it answers only from chunks the caller could already open by hand,
 * and every claim carries the link to do so. A viewer who can read the graph
 * can read the graph faster.
 *
 * The retrieval, the grounding prompt and the abstain behaviour live in
 * `documents/ask.ts`, shared with the `ask_docs` MCP tool so a human and an
 * agent asking the same question get the same answer.
 */

const askSchema = z.object({
  question: z.string().min(3).max(500),
});

askRoutes.post("/ask", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const { question } = askSchema.parse(await c.req.json());

  return c.json(await askDocuments(orgId, question));
});
