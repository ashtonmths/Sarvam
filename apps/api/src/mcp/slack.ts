import { z } from "zod";
import { retrieveRationale } from "../historian/retrieve.js";
import { readThread, searchSlack, tsToIso } from "../historian/tools/slack.js";
import { complete, LlmDisabledError, LlmQuotaExhaustedError } from "../llm.js";
import type { McpContext } from "./tools.js";

/**
 * Answering a question from what the organisation actually said in Slack.
 *
 * Three sources, because "the Slack context" is three different things and an
 * answer drawn from only one of them is confidently partial:
 *
 *  - the **live search** over the channels an admin selected for mining, which
 *    is the only source that knows what was said this morning;
 *  - the **threads** hanging off the best of those hits, because a decision is
 *    almost never in the message that matches the keywords — it is four replies
 *    down, in the message that says "ok, let's do B then";
 *  - the **rationale already mined** and stored by Historian, which is the part
 *    of Slack that has survived past a channel's history limit and has been
 *    reviewed by a human.
 *
 * Channel scope is never this tool's decision. `searchSlack` reads the channel
 * list from `mining_scopes` server-side and strips any `in:`/`from:` qualifier
 * out of the query, so no argument reaching this function — from a model or
 * from a person — can widen what is read. That property is why the question is
 * passed through as prose rather than as a search expression.
 *
 * The reasoning is returned as its own field rather than folded into the
 * answer. A Slack answer is an inference over a conversation — someone
 * proposed, someone objected, the thread went quiet, a decision was implied —
 * and the chain of steps that produced it is the part a human needs in order to
 * disagree with it. An answer whose reasoning is invisible can only be believed
 * or ignored.
 */

/** Enough to cover a discussion that spans two threads; short of a channel dump. */
const MAX_SOURCES = 14;

/** Threads are a request each and the tail of a long one is rarely the point. */
const THREADS_EXPANDED = 3;

/** The durable half of the corpus. Capped low: it is a supplement, not the answer. */
const RATIONALE_SOURCES = 4;

const EXCERPT = 600;

/**
 * A Slack permalink always carries `/archives/<channel>/p<ts>`, which is how a
 * stored rationale row is known to have come from Slack. The `rationale` table
 * does record `sourceKind`, but `retrieveRationale` does not project it, and
 * matching the permalink here is both cheaper than widening that query and
 * exactly as reliable — the URL is what a reader would follow anyway.
 */
const SLACK_PERMALINK = /\/archives\/[A-Z0-9]+\/p\d+/i;

const SYSTEM = `You answer questions about an engineering organisation using only the numbered Slack messages provided.

Slack is conversation, not record. Treat it accordingly:
- A proposal is not a decision. Look for whether anyone agreed, objected, or acted.
- The newest message on a point supersedes older ones. Say when something was later reversed.
- Silence is not consent, and you must not report it as agreement.
- People are imprecise in chat. Do not sharpen a hedge into a commitment.

Answer in exactly two sections, with these headings on their own lines:

ANSWER:
The answer itself. Cite the messages you used as [1], [2] inline, immediately after the claim each supports. Be brief — two or three sentences unless the question genuinely needs more. If the messages do not answer the question, say so plainly. That is a correct answer, not a failure.

REASONING:
How you got there, in two to five short sentences. Name which messages you leaned on and why, in what order the conversation moved, and what you had to infer rather than read. If you are uncertain, or the thread was ambiguous, or the decision was implied rather than stated, say so here explicitly. If you found contradicting messages, say which you believed and why.

Use only the messages given. Do not add background knowledge or plausible detail.`;

export const askSlackInput = z.object({
  question: z
    .string()
    .min(3)
    .max(500)
    .describe(
      'A specific question in prose, e.g. "did we agree to drop the nightly reconciliation job?" or "who owns the billing webhook?". Ask it the way you would ask a colleague — this is searched as words, not as a Slack query. Channel and user filters such as "in:#eng" are stripped and ignored; which channels may be read is an administrator\'s setting, not an argument.',
    ),
  expand_threads: z
    .boolean()
    .default(true)
    .describe(
      "Follow the replies under the strongest matches. Usually the decision is in a reply rather than in the message that matched, so leave this on unless you only want the matching lines themselves.",
    ),
});

export const askSlackOutput = z.object({
  answer: z.string(),
  /** How the answer was reached. Null when no model was called. */
  reasoning: z.string().nullable(),
  /** True only when a model synthesised an answer from retrieved messages. */
  grounded: z.boolean(),
  /** Set when messages were found but the model could not be called. */
  unavailable: z.string().nullable(),
  sources: z.array(
    z.object({
      n: z.number(),
      kind: z.enum(["message", "thread_reply", "mined_rationale"]),
      author: z.string(),
      permalink: z.string(),
      occurred_at: z.string().nullable(),
      excerpt: z.string(),
    }),
  ),
  /** What could not be searched, said out loud. */
  notes: z.array(z.string()),
});

type Input = z.infer<typeof askSlackInput>;

interface SlackSource {
  n: number;
  kind: "message" | "thread_reply" | "mined_rationale";
  author: string;
  permalink: string;
  occurred_at: string | null;
  excerpt: string;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export const NOTHING_FOUND =
  "Nothing in the Slack channels this organisation has connected mentions that. Either it was not discussed in those channels, or the channel it was discussed in has not been connected for mining.";

/**
 * Collects the messages, deduplicated by permalink and numbered once.
 *
 * Deduplication is by permalink rather than by text because the same message
 * legitimately arrives twice — once as a search hit and again as a reply inside
 * its own thread — and numbering it twice would let the model cite [3] and [9]
 * as two pieces of corroborating evidence for a claim that only one person ever
 * made. That is the specific way a citation list stops being a check on the
 * answer and starts being decoration.
 */
async function gather(
  ctx: McpContext,
  input: Input,
  notes: string[],
): Promise<SlackSource[]> {
  const [live, mined] = await Promise.allSettled([
    searchSlack({ orgId: ctx.orgId }, input.question),
    retrieveRationale(ctx.orgId, input.question, {
      states: ["confirmed", "drafted"],
      limit: RATIONALE_SOURCES * 3,
    }),
  ]);

  const byPermalink = new Map<string, SlackSource>();
  const add = (source: Omit<SlackSource, "n">) => {
    if (byPermalink.size >= MAX_SOURCES) return;
    if (!source.permalink || byPermalink.has(source.permalink)) return;
    byPermalink.set(source.permalink, { n: 0, ...source });
  };

  let hits: Array<{
    permalink: string;
    text: string;
    author: string;
    ts: string;
    authored_at: string | null;
  }> = [];

  if (live.status === "rejected") {
    notes.push(
      `Slack could not be searched (${live.reason instanceof Error ? live.reason.message : String(live.reason)}), so this answer draws only on rationale already mined from it.`,
    );
  } else {
    if (live.value.unavailable) notes.push(live.value.unavailable);
    hits = live.value.hits;
    for (const hit of hits) {
      add({
        kind: "message",
        author: hit.author,
        permalink: hit.permalink,
        occurred_at: hit.authored_at ?? tsToIso(hit.ts),
        excerpt: clip(hit.text, EXCERPT),
      });
    }
  }

  /**
   * Threads after the hits, so the messages that actually matched are numbered
   * first and a truncated list keeps them. Sequential rather than parallel: a
   * thread read is several Slack calls behind one rate limit, and three threads
   * fanned out concurrently is how a tool call starts returning 429s instead of
   * answers.
   */
  if (input.expand_threads && hits.length > 0) {
    for (const hit of hits.slice(0, THREADS_EXPANDED)) {
      if (byPermalink.size >= MAX_SOURCES) break;
      try {
        const thread = await readThread({ orgId: ctx.orgId }, hit.permalink);
        for (const message of thread.messages) {
          add({
            kind: "thread_reply",
            author: message.author,
            permalink: message.permalink,
            occurred_at: message.authored_at,
            excerpt: clip(message.text, EXCERPT),
          });
        }
      } catch {
        // A thread that will not open costs its own replies and nothing else;
        // the message that matched is already in the list.
        notes.push(`The thread under ${hit.permalink} could not be opened.`);
      }
    }
  }

  if (mined.status === "rejected") {
    notes.push(
      "Previously mined Slack rationale could not be read, so this answer omits it.",
    );
  } else {
    const fromSlack = mined.value
      .filter((row) => SLACK_PERMALINK.test(row.sourceUrl))
      .slice(0, RATIONALE_SOURCES);
    for (const row of fromSlack) {
      add({
        kind: "mined_rationale",
        author: row.author ?? "unknown",
        permalink: row.sourceUrl,
        occurred_at: null,
        excerpt: clip(row.body, EXCERPT),
      });
    }
  }

  return [...byPermalink.values()].map((source, i) => ({ ...source, n: i + 1 }));
}

/**
 * Splits the model's two sections.
 *
 * Tolerant on purpose. A model that ignores the format and returns one block of
 * prose has still answered the question, and failing the tool call over a
 * missing heading would throw away a good answer to enforce a layout. The
 * whole content becomes the answer and `reasoning` is null, which is honest —
 * there is no reasoning to show.
 */
export function splitSections(content: string): {
  answer: string;
  reasoning: string | null;
} {
  const match = /ANSWER:\s*([\s\S]*?)\n\s*REASONING:\s*([\s\S]*)$/i.exec(content);
  if (match) {
    return {
      answer: (match[1] ?? "").trim(),
      reasoning: (match[2] ?? "").trim() || null,
    };
  }

  // A lone ANSWER: heading and no reasoning section.
  const answerOnly = /ANSWER:\s*([\s\S]*)$/i.exec(content);
  if (answerOnly) return { answer: (answerOnly[1] ?? "").trim(), reasoning: null };

  return { answer: content.trim(), reasoning: null };
}

export function renderAskSlackText(
  result: {
    answer: string;
    reasoning: string | null;
    unavailable: string | null;
    sources: SlackSource[];
    notes: string[];
  },
  question: string,
): string {
  const lines: string[] = [];

  if (result.sources.length === 0) {
    lines.push(result.answer);
    if (result.notes.length > 0) {
      lines.push("", "Why there was nothing to search:");
      for (const note of result.notes) lines.push(`  - ${note}`);
    }
    return lines.join("\n");
  }

  if (result.unavailable) {
    lines.push(result.unavailable);
    lines.push(
      "",
      `No answer was written. Read the messages below and answer from them, or tell your human the model is unavailable. Do not answer "${question}" from your own knowledge.`,
    );
  } else {
    lines.push(result.answer);
    if (result.reasoning) {
      lines.push("", "How this was reached:", result.reasoning);
    }
  }

  lines.push("", "Slack messages this rests on:");
  for (const source of result.sources) {
    const when = source.occurred_at ? source.occurred_at.slice(0, 10) : "undated";
    const kind =
      source.kind === "thread_reply"
        ? "reply in thread"
        : source.kind === "mined_rationale"
          ? "previously mined, human-reviewed"
          : "message";
    lines.push(`  [${source.n}] ${source.author} (${when}, ${kind}) ${source.permalink}`);
    lines.push(`      ${source.excerpt}`);
  }

  if (result.notes.length > 0) {
    lines.push("", "What this answer does NOT cover:");
    for (const note of result.notes) lines.push(`  - ${note}`);
  }

  lines.push(
    "",
    "Slack is a conversation, not a record. Keep the links when you relay this so your human can read the thread themselves.",
  );

  return lines.join("\n");
}

export async function askSlack(ctx: McpContext, input: Input) {
  const notes: string[] = [];
  const sources = await gather(ctx, input, notes);

  /**
   * No messages, no model call. Retrieval finding nothing is already the
   * answer, and spending a request from a shared per-minute budget to have a
   * model restate it produces a worse version of this sentence.
   */
  if (sources.length === 0) {
    const structured = {
      answer: NOTHING_FOUND,
      reasoning: null,
      grounded: false,
      unavailable: null,
      sources: [],
      notes,
    };
    return {
      structured,
      text: renderAskSlackText({ ...structured, unavailable: null }, input.question),
    };
  }

  const context = sources
    .map((source) => {
      const when = source.occurred_at
        ? source.occurred_at.slice(0, 16).replace("T", " ")
        : "undated";
      const kind =
        source.kind === "thread_reply"
          ? " (reply in the thread under an earlier match)"
          : source.kind === "mined_rationale"
            ? " (quoted and reviewed previously)"
            : "";
      return `[${source.n}] ${source.author}, ${when}${kind}\n${source.excerpt}`;
    })
    .join("\n\n");

  try {
    const completion = await complete({
      tier: "strong",
      orgId: ctx.orgId,
      caller: "mcp.ask_slack",
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Slack messages:\n\n${context}\n\nQuestion: ${input.question}`,
        },
      ],
    });

    const { answer, reasoning } = splitSections(completion.content?.trim() ?? "");
    const structured = {
      answer,
      reasoning,
      grounded: true,
      unavailable: null,
      // Returned whether or not the model cited them: a reader can only judge
      // whether the answer is supported if they see everything it was shown.
      sources,
      notes,
    };
    return {
      structured,
      text: renderAskSlackText({ ...structured, unavailable: null }, input.question),
    };
  } catch (error) {
    if (error instanceof LlmDisabledError || error instanceof LlmQuotaExhaustedError) {
      /**
       * The retrieval already did the expensive and privileged part — reaching
       * into channels this credential is entitled to read. Handing back the
       * messages with no prose is far more use than an error, and it keeps the
       * agent from answering the question from memory instead.
       */
      const unavailable =
        error instanceof LlmDisabledError
          ? "The model is switched off for this deployment. These are the Slack messages that match the question."
          : "The model's request budget is spent for now. These are the Slack messages that match the question.";

      const structured = {
        answer: "",
        reasoning: null,
        grounded: false,
        unavailable,
        sources,
        notes,
      };
      return {
        structured,
        text: renderAskSlackText({ ...structured, unavailable }, input.question),
      };
    }
    throw error;
  }
}
