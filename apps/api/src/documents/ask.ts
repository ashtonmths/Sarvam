import { complete, LlmDisabledError, LlmQuotaExhaustedError } from "../llm.js";
import { type DocumentHit, searchDocuments } from "./retrieve.js";

/**
 * Answering a question in prose from this org's own documents.
 *
 * Lives here rather than in the route because it has two callers with one
 * contract: `POST /ask` for a human in the web app, and the `ask_docs` MCP tool
 * for an agent. Retrieval breadth, the grounding instruction and the abstain
 * behaviour are the product, and a second copy of them in the MCP adapter is
 * how the agent and the human start getting different answers to the same
 * question — with nothing failing to reveal it.
 */

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

export const NO_SOURCES_ANSWER =
  "Nothing in this organisation's documents covers that. Upload the meeting notes or transcript that would, and ask again.";

export interface AskSource {
  n: number;
  title: string;
  speaker: string | null;
  permalink: string;
  occurredAt: Date | null;
  excerpt: string;
}

export interface AskAnswer {
  answer: string;
  sources: AskSource[];
  grounded: boolean;
  /** Set only when retrieval succeeded but the model could not be called. */
  unavailable?: string;
}

/** The citation list a reader checks the answer against. */
function citations(hits: DocumentHit[]): AskSource[] {
  return hits.map((hit, i) => ({
    n: i + 1,
    title: hit.title,
    speaker: hit.speaker,
    permalink: hit.permalink,
    occurredAt: hit.occurredAt,
    excerpt: hit.body.length > 240 ? `${hit.body.slice(0, 240)}…` : hit.body,
  }));
}

export async function askDocuments(orgId: number, question: string): Promise<AskAnswer> {
  const hits = await searchDocuments(orgId, question, SOURCES);

  /**
   * No sources, no model call. Retrieval returning nothing is already the
   * answer, and spending a request to have the model say so costs a slot from
   * a shared per-minute budget to produce a worse version of this sentence.
   */
  if (hits.length === 0) {
    return { answer: NO_SOURCES_ANSWER, sources: [], grounded: false };
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

    return {
      answer: completion.content?.trim() ?? "",
      // Returned whether or not the model cited them. The reader decides
      // whether the answer is supported, which they cannot do if the evidence
      // is filtered to whatever the model happened to mention.
      sources: citations(hits),
      grounded: true,
    };
  } catch (error) {
    /**
     * The model being off or out of quota is a state of the deployment, not a
     * bug in the request, so this returns the sources it found and says the
     * prose is missing. Retrieval already did the expensive part, and a reader
     * handed eight relevant excerpts is better served than one handed an error.
     */
    if (error instanceof LlmDisabledError || error instanceof LlmQuotaExhaustedError) {
      return {
        answer: "",
        unavailable:
          error instanceof LlmDisabledError
            ? "The model is switched off for this deployment. These are the passages that match your question."
            : "The model's request budget is spent for now. These are the passages that match your question.",
        sources: citations(hits),
        grounded: false,
      };
    }
    throw error;
  }
}
