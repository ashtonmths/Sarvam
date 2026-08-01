import { rationale, rationaleLinks, verdicts } from "@sadhak/shared/schema";
import type { VerdictResult } from "@sadhak/shared/types";
import { and, eq, inArray, ne, sql as raw } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { embed } from "../embed.js";
import { completeStream, LlmDisabledError, LlmQuotaExhaustedError } from "../llm.js";

/**
 * Turns "impact 0.94 via 2 hops" into "this feeds EU VAT reporting, per
 * Priya's 2024 thread" — retrieval-grounded, permalink-cited, and structurally
 * incapable of changing the verdict, because the verdict is already persisted
 * before this module runs. Explain never re-traverses, so prose and verdict
 * cannot diverge.
 */

export interface RetrievedRationale {
  id: number;
  body: string;
  sourceUrl: string;
  author: string | null;
  state: string;
}

/**
 * Hybrid retrieval in one statement. Node names like `vat_rate` appear
 * verbatim in the threads being searched, so lexical rank matters as much as
 * cosine — neither branch alone finds what the other does.
 */
export async function retrieveForVerdict(
  orgId: number,
  queryText: string,
  edgeIds: number[],
): Promise<RetrievedRationale[]> {
  if (edgeIds.length === 0) return [];

  let embedding: number[] | null = null;
  try {
    embedding = await embed(queryText);
  } catch {
    // Retrieval survives without the model: the lexical branch still matches,
    // which is what keeps the wifi drill honest.
  }

  const vectorLiteral = embedding ? `[${embedding.join(",")}]` : null;

  const rows = await db
    .select({
      id: rationale.id,
      body: rationale.body,
      sourceUrl: rationale.sourceUrl,
      author: rationale.author,
      state: rationale.state,
    })
    .from(rationale)
    .innerJoin(rationaleLinks, eq(rationaleLinks.rationaleId, rationale.id))
    .where(
      and(
        eq(rationale.orgId, orgId),
        // inArray, not `= ANY($1)`: Drizzle's sql`` binds an array as a
        // scalar, which Postgres rejects at runtime rather than at compile
        // time. Raw postgres.js binds arrays correctly; Drizzle does not.
        inArray(rationaleLinks.edgeId, edgeIds),
        ne(rationale.state, "rejected"),
      ),
    )
    /**
     * NULLS LAST is load-bearing. Every producer inserts with a null embedding
     * and lets the worker fill it in, so a freshly captured rationale has one
     * for as long as the embed queue takes. The cosine term is then NULL, the
     * whole expression is NULL, and Postgres sorts NULL first under DESC — so
     * the newest, least-scored row outranked every relevant one and evicted
     * them under the limit.
     */
    .orderBy(
      raw`(${rationale.state} = 'confirmed') DESC`,
      vectorLiteral
        ? raw`0.5 * ts_rank(to_tsvector('english', ${rationale.body}), plainto_tsquery('english', ${queryText}))
             + 0.5 * COALESCE(1 - (${rationale.embedding} <=> ${vectorLiteral}::vector), 0) DESC NULLS LAST`
        : raw`ts_rank(to_tsvector('english', ${rationale.body}), plainto_tsquery('english', ${queryText})) DESC NULLS LAST`,
    )
    .limit(8);

  return rows;
}

const SYSTEM_PROMPT = `You explain the consequences of a proposed change to an operations graph.

Rules, without exception:
- Cite a source_url for every factual claim about why something exists.
- If no rationale was retrieved, say the dependency is undocumented. Never invent a reason.
- Rationale marked "unconfirmed" is a draft: hedge accordingly and say it is unconfirmed.
- Be brief. Three sentences at most. No preamble, no headings, no bullet lists.
- Never state or imply a verdict different from the one given. You explain it; you do not decide it.`;

function buildPrompt(result: VerdictResult, retrieved: RetrievedRationale[]): string {
  const top = result.impacted.slice(0, 5);
  const lines = [
    `Change: ${result.change.operation} ${result.change.target} "${result.change.externalId}" (${result.change.connector})`,
    `Verdict: ${result.verdict}`,
    "",
    "Impacted:",
    ...top.map(
      (row) =>
        `- ${row.name} (${row.kind}) impact ${row.impact.toFixed(2)}, ${row.hops} hop(s), min edge confidence ${row.minEdgeConfidence.toFixed(2)}`,
    ),
    "",
    "Evidence rules that fired:",
    ...result.evidence.map((e) => `- ${e.rule} → ${e.name}`),
  ];

  if (retrieved.length > 0) {
    lines.push("", "Retrieved rationale:");
    for (const r of retrieved) {
      const label = r.state === "confirmed" ? "confirmed" : "unconfirmed draft";
      lines.push(
        `- [${label}] "${r.body.slice(0, 400)}" — ${r.author ?? "unknown"} ${r.sourceUrl}`,
      );
    }
  } else {
    lines.push("", "Retrieved rationale: none. This dependency is undocumented.");
  }

  return lines.join("\n");
}

export type ExplainEvent =
  | { type: "delta"; text: string }
  | { type: "done"; text: string }
  | { type: "failed" }
  | { type: "disabled" }
  | { type: "quota_exhausted"; resetAt: string | null };

/**
 * Streams prose for an already-persisted verdict. Every terminal path updates
 * `explanation_state`; the `verdict` column is never touched from here.
 */
export async function* explainVerdict(
  orgId: number,
  result: VerdictResult,
  signal?: AbortSignal,
): AsyncGenerator<ExplainEvent> {
  const edgeIds = [
    ...new Set(result.impacted.flatMap((r) => r.path.map((h) => h.edgeId))),
  ];
  const queryText = [
    result.change.externalId.split(/[/.]/).pop() ?? result.change.externalId,
    ...result.impacted.slice(0, 3).map((r) => r.name),
  ].join(" ");

  let retrieved: RetrievedRationale[] = [];
  try {
    retrieved = await retrieveForVerdict(orgId, queryText, edgeIds);
  } catch {
    /* retrieval failure degrades prose quality, never the verdict */
  }

  const chunks: string[] = [];
  try {
    // Retrying prose is pointless: the verdict already rendered.
    const stream = completeStream({
      tier: "bulk",
      caller: "sentinel.explain",
      orgId,
      timeoutMs: 8_000,
      maxRetries: 0,
      ...(signal ? { signal } : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(result, retrieved) },
      ],
    });

    for await (const delta of stream) {
      chunks.push(delta);
      yield { type: "delta", text: delta };
    }

    const text = chunks.join("").trim();
    await persistState(orgId, result.id, "streamed", text);
    yield { type: "done", text };
  } catch (error) {
    if (error instanceof LlmDisabledError) {
      await persistState(orgId, result.id, "disabled", null);
      yield { type: "disabled" };
      return;
    }
    if (error instanceof LlmQuotaExhaustedError) {
      await persistState(orgId, result.id, "quota_exhausted", null);
      yield { type: "quota_exhausted", resetAt: error.resetAt };
      return;
    }
    await persistState(orgId, result.id, "failed", null);
    yield { type: "failed" };
  }
}

async function persistState(
  orgId: number,
  verdictId: string,
  state: string,
  text: string | null,
): Promise<void> {
  await db
    .update(verdicts)
    .set({ explanationState: state, ...(text === null ? {} : { explanation: text }) })
    .where(and(eq(verdicts.id, verdictId), eq(verdicts.orgId, orgId)));
}

/** Whether an explanation could be produced at all right now. */
export function explanationsAvailable(): boolean {
  return !config.LLM_DISABLED && Boolean(config.OPENROUTER_API_KEY);
}
