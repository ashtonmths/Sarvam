import { n8nExecutionFailures } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { db, sql as raw } from "../db.js";
import { searchDocuments } from "../documents/retrieve.js";
import { complete } from "../llm.js";
import { log } from "../log.js";

/**
 * Answering an engineer who replies to the alert.
 *
 * The thread already contains the diagnosis, so a question asked in it is
 * almost never "what happened" — it is "how do I actually do that", "why not
 * the other fix", "who else is affected". Those are answerable from what was
 * already gathered, which is why this reuses the stored diagnosis rather than
 * starting a new investigation.
 *
 * Scoped to the thread on purpose. The bot answers where it was asked and says
 * nothing in the channel, so a conversation between two people about one
 * workflow does not become everyone's notification.
 */

const SYSTEM = `You are answering an engineer in a Slack thread about a workflow failure you already diagnosed.

You are given the diagnosis, the impact, the evidence, and any notes that mention it. Answer the question asked — nothing else.

Rules:
- Be direct and short. Two or three sentences unless they asked for steps, in which case give numbered steps.
- Answer from what you were given. If the answer is not in it, say what you would need to look at and stop.
- Do not restate the diagnosis they can already see above.
- No greeting, no sign-off, no "great question".
- Slack markdown: *bold* is single asterisks, \`code\` in backticks.`;

/** Strips the `<@U123>` mentions so the model sees the question, not the ping. */
export function questionFrom(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

/**
 * Finds the failure a thread belongs to.
 *
 * Keyed on the parent message's ts, which is what we stored when the alert was
 * posted — so a reply anywhere in that thread resolves to the right failure
 * without needing to parse anything out of the text.
 */
export async function failureForThread(
  channel: string,
  threadTs: string,
): Promise<number | null> {
  const [row] = (await raw`
    SELECT id FROM n8n_execution_failures
    WHERE slack_channel_id = ${channel} AND slack_ts = ${threadTs}
    LIMIT 1
  `) as unknown as Array<{ id: number }>;
  return row ? Number(row.id) : null;
}

export async function answerInThread(
  failureId: number,
  question: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(n8nExecutionFailures)
    .where(eq(n8nExecutionFailures.id, failureId));
  if (!row?.diagnosis) return null;

  const d = row.diagnosis as unknown as {
    cause?: string;
    recommendation?: string;
    confidence?: number;
    impact?: { count: number; top: Array<{ name: string; kind: string; hops: number }> };
    evidence?: Array<{ source: string; detail: string }>;
    searchReach?: string;
  };

  // The written record again, searched on the question rather than the error —
  // "how do I restore it" and "column does not exist" match different notes.
  const docs = await searchDocuments(row.orgId, question, 3).catch(() => []);

  const context = [
    `Workflow: ${row.workflowName ?? row.workflowId}`,
    row.failedNode ? `Failed at: ${row.failedNode}` : null,
    row.errorMessage ? `Error: ${row.errorMessage}` : null,
    `Cause: ${d.cause ?? "(none recorded)"}`,
    `Recommendation: ${d.recommendation ?? "(none)"}`,
    d.searchReach ? `Searched: ${d.searchReach}` : null,
    d.impact?.count
      ? `Depends on it (${d.impact.count}): ${d.impact.top.map((n) => n.name).join(", ")}`
      : "Nothing recorded downstream.",
    d.evidence?.length
      ? `Evidence:\n${d.evidence.map((e) => `- ${e.source}: ${e.detail}`).join("\n")}`
      : null,
    docs.length
      ? `Notes:\n${docs.map((x) => `- ${x.title}: ${x.body.slice(0, 400)}`).join("\n")}`
      : null,
    "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");

  const completion = await complete({
    tier: "strong",
    orgId: row.orgId,
    caller: "ci.converse",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: context },
    ],
  });

  const answer = completion.content?.trim();
  if (!answer) return null;

  log().info({ event: "ci_thread_answered", failureId }, "ci: answered in thread");
  return answer;
}
