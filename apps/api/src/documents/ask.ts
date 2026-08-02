import { searchSlack, tsToIso } from "../historian/tools/slack.js";
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
 * Slack is searched live rather than mirrored into the document corpus.
 *
 * A synced copy would rank in one embedding space with the documents, which is
 * tidier — but it is also stale by exactly the interval nobody tunes, and the
 * questions worth asking here ("what did we decide", "is this still true") are
 * the ones where a day-old answer is a wrong answer. Live costs a request per
 * ask and gives up cross-source ranking; that trade is the right way round for
 * a tool whose whole claim is that you can check what it told you.
 *
 * Capped low. These are appended to eight document chunks, and the point is to
 * catch the decision that was made in a thread and never written down — not to
 * turn the prompt into a channel dump.
 */
const SLACK_SOURCES = 5;

/** Slack messages run long and repetitive; the tail is rarely the substance. */
const SLACK_EXCERPT = 400;

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

Sources are of two kinds. A document is written and usually reviewed; a Slack message is a moment in a conversation and may be superseded by a later one. Weigh them accordingly, and say when a thread and a document disagree.

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
  /** Which corpus this came from, so a reader can weigh a thread against a
   * minuted decision rather than seeing one undifferentiated list. */
  kind: "document" | "slack";
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
  /**
   * Sources that could not be consulted, said out loud.
   *
   * Slack being unconnected and Slack being searched-and-empty are different
   * facts, and collapsing them lets a reader believe a thread was checked when
   * it never was. That belief is the one this product exists to remove.
   */
  notes?: string[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The citation list a reader checks the answer against. */
function citations(hits: DocumentHit[]): AskSource[] {
  return hits.map((hit, i) => ({
    n: i + 1,
    kind: "document" as const,
    title: hit.title,
    speaker: hit.speaker,
    permalink: hit.permalink,
    occurredAt: hit.occurredAt,
    excerpt: clip(hit.body, 240),
  }));
}

export async function askDocuments(orgId: number, question: string): Promise<AskAnswer> {
  /**
   * Both corpora at once. Slack is a network call to a third party and
   * documents are a local index, so running them in series would spend the
   * slower one's latency on every question for no reason. `allSettled`
   * because Slack throwing must cost Slack's sources, never the answer.
   */
  const [documents, slack] = await Promise.allSettled([
    searchDocuments(orgId, question, SOURCES),
    searchSlack({ orgId }, question),
  ]);

  const docHits = documents.status === "fulfilled" ? documents.value : [];
  const notes: string[] = [];

  if (documents.status === "rejected") {
    notes.push("The document index could not be searched, so this answer omits it.");
  }

  let slackSources: AskSource[] = [];
  if (slack.status === "rejected") {
    notes.push("Slack could not be reached, so this answer omits it.");
  } else {
    if (slack.value.unavailable) notes.push(slack.value.unavailable);
    slackSources = slack.value.hits.slice(0, SLACK_SOURCES).map((hit, i) => ({
      // Numbered after the documents, so `[1]` means the same thing in the
      // prose and in the list below it.
      n: docHits.length + i + 1,
      kind: "slack" as const,
      title: `Slack · ${hit.author}`,
      speaker: hit.author,
      permalink: hit.permalink,
      occurredAt: hit.authored_at
        ? new Date(hit.authored_at)
        : (() => {
            const iso = tsToIso(hit.ts);
            return iso ? new Date(iso) : null;
          })(),
      excerpt: clip(hit.text, SLACK_EXCERPT),
    }));
  }

  const sources = [...citations(docHits), ...slackSources];

  /**
   * No sources, no model call. Retrieval returning nothing is already the
   * answer, and spending a request to have the model say so costs a slot from
   * a shared per-minute budget to produce a worse version of this sentence.
   */
  if (sources.length === 0) {
    return {
      answer: NO_SOURCES_ANSWER,
      sources: [],
      grounded: false,
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  const context = sources
    .map((source) => {
      const when = source.occurredAt
        ? source.occurredAt.toISOString().slice(0, 10)
        : "undated";
      const who = source.speaker ? `, ${source.speaker}` : "";
      const full =
        source.kind === "document"
          ? (docHits[source.n - 1]?.body ?? source.excerpt)
          : source.excerpt;
      return `[${source.n}] ${source.title} (${when}${who})\n${full}`;
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
      sources,
      grounded: true,
      ...(notes.length > 0 ? { notes } : {}),
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
        sources,
        grounded: false,
        ...(notes.length > 0 ? { notes } : {}),
      };
    }
    throw error;
  }
}
