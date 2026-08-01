import { Hono } from "hono";
import { z } from "zod";
import { searchDocuments } from "../documents/retrieve.js";
import { complete, LlmDisabledError, LlmQuotaExhaustedError } from "../llm.js";
import { requireCapability } from "../middleware/auth.js";

export const askRoutes = new Hono();

/**
 * Ask a question in prose, get an answer grounded in this org's own documents.
 *
 * `graph:read`, deliberately the same capability as reading a node. This adds
 * no reach: it answers only from chunks the caller could already open by hand,
 * and every claim carries the link to do so. A viewer who can read the graph
 * can read the graph faster.
 */

const askSchema = z.object({
  question: z.string().min(3).max(500),
});

/** Retrieved breadth. Eight chunks is roughly 10k characters — enough for a
 * question that spans two meetings, short enough to stay inside the free
 * tier's context and to keep the citation list readable. */
const SOURCES = 8;

/**
 * The instruction that makes this different from a chat window.
 *
 * The whole product claim is that an answer is worth having only when you can
 * check it, so the model is told to cite or abstain, and abstaining is stated
 * as a correct outcome rather than a failure. A model that pads a thin answer
 * with plausible organisational detail is worse than one that says the notes do
 * not cover it — the padding is indistinguishable from a real finding, and it
 * is exactly the thing a reader has no way to catch.
 */
const SYSTEM = `You answer questions about an engineering organisation using only the numbered sources provided.

Rules:
- Use only the sources. Do not add background knowledge, plausible detail, or anything you were not given.
- Cite the sources you used as [1], [2] inline, immediately after the claim they support.
- If the sources do not answer the question, say so plainly and stop. That is a correct answer, not a failure.
- If the sources disagree, say that they disagree and cite both.
- Be brief. Two or three sentences unless the question genuinely needs more.
- Write plainly. No preamble, no restating the question, no closing summary.`;

askRoutes.post("/ask", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const { question } = askSchema.parse(await c.req.json());

  const hits = await searchDocuments(orgId, question, SOURCES);

  /**
   * No sources, no model call. Retrieval returning nothing is already the
   * answer, and spending a request to have the model say so costs a slot from
   * a shared per-minute budget to produce a worse version of this sentence.
   */
  if (hits.length === 0) {
    return c.json({
      answer:
        "Nothing in this organisation's documents covers that. Upload the meeting notes or transcript that would, and ask again.",
      sources: [],
      grounded: false,
    });
  }

  const context = hits
    .map((hit, i) => {
      const when = hit.occurredAt ? hit.occurredAt.toISOString().slice(0, 10) : "undated";
      const who = hit.speaker ? `, ${hit.speaker}` : "";
      return `[${i + 1}] ${hit.title} (${when}${who})\n${hit.body}`;
    })
    .join("\n\n");

  try {
    const completion = await complete({
      tier: "strong",
      orgId,
      caller: "ask",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Sources:\n\n${context}\n\nQuestion: ${question}` },
      ],
    });

    return c.json({
      answer: completion.content?.trim() ?? "",
      // Returned whether or not the model cited them. The reader decides
      // whether the answer is supported, which they cannot do if the evidence
      // is filtered to whatever the model happened to mention.
      sources: hits.map((hit, i) => ({
        n: i + 1,
        title: hit.title,
        speaker: hit.speaker,
        permalink: hit.permalink,
        occurredAt: hit.occurredAt,
        excerpt: hit.body.length > 240 ? `${hit.body.slice(0, 240)}…` : hit.body,
      })),
      grounded: true,
    });
  } catch (error) {
    /**
     * The model being off or out of quota is a state of the deployment, not a
     * bug in the request, so this answers 200 with the sources it found and
     * says the prose is missing. Retrieval already did the expensive part, and
     * a reader handed eight relevant excerpts is better served than one handed
     * an error — which is also what a non-2xx would force, since the client
     * raises on status and never sees the body.
     */
    if (error instanceof LlmDisabledError || error instanceof LlmQuotaExhaustedError) {
      return c.json({
        answer: "",
        unavailable:
          error instanceof LlmDisabledError
            ? "The model is switched off for this deployment. These are the passages that match your question."
            : "The model's request budget is spent for now. These are the passages that match your question.",
        sources: hits.map((hit, i) => ({
          n: i + 1,
          title: hit.title,
          speaker: hit.speaker,
          permalink: hit.permalink,
          occurredAt: hit.occurredAt,
          excerpt: hit.body.length > 240 ? `${hit.body.slice(0, 240)}…` : hit.body,
        })),
        grounded: false,
      });
    }
    throw error;
  }
});
