import {
  edges as edgesTable,
  nodes as nodesTable,
  rationale,
  rationaleLinks,
} from "@sadhak/shared/schema";
import { changeDescriptorSchema, type VerdictResult } from "@sadhak/shared/types";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { type AskAnswer, askDocuments } from "../documents/ask.js";
import { decide } from "../gate/decide.js";
import { blastRadius, resolveNode } from "../sentinel/verdict.js";

/**
 * The tools an agent runtime sees. Thin adapters over the exact functions the
 * REST route calls, with the exact zod schemas from the shared package — so
 * REST and MCP cannot drift.
 */

export const proposeChangeInput = z.object({
  change: changeDescriptorSchema,
  dry_run: z.boolean().default(false),
});

export const nodeRefInput = z.object({
  connector: z.enum(["n8n", "airtable", "postgres", "github", "slack"]),
  externalId: z.string().min(1),
});

/** The same bounds as `POST /ask`, for the same reasons: below three
 * characters there is nothing to retrieve on, and above five hundred the
 * caller is pasting a document rather than asking about one. */
export const askDocsInput = z.object({
  question: z.string().min(3).max(500),
});

export interface McpContext {
  orgId: number;
  apiKeyId: number;
  scopes: string[];
  clientName?: string | undefined;
}

/**
 * A BLOCK must be *legible to the agent*: what would break, why, and that the
 * change was not and will not be executed — so it relays an accurate answer to
 * its human instead of retrying in a loop.
 */
export function renderVerdictText(result: VerdictResult, dryRun: boolean): string {
  const lines: string[] = [];
  const headline = {
    BLOCK: "BLOCKED — this change was NOT executed and will not be.",
    WARN: "WARNING — this change is allowed but has a real blast radius.",
    APPROVE: "APPROVED — no dependency crosses a risk threshold.",
  }[result.verdict];

  lines.push(headline);
  lines.push(
    `Change: ${result.change.operation} ${result.change.target} "${result.change.externalId}"`,
  );

  if (result.evidence.length > 0) {
    lines.push("", "Why:");
    for (const e of result.evidence) {
      lines.push(`  - ${e.rule} → ${e.name} (impact ${e.impact.toFixed(2)})`);
    }
  }

  const top = result.impacted.slice(0, 5);
  if (top.length > 0) {
    lines.push("", `Blast radius (${result.impacted.length} nodes reached):`);
    for (const row of top) {
      lines.push(
        `  - ${row.name} (${row.kind}) impact ${row.impact.toFixed(2)}, ${row.hops} hop(s)`,
      );
    }
  }

  lines.push("", `Computed deterministically in ${result.computedInMs}ms.`);
  if (dryRun) lines.push("This was a simulation; nothing was recorded as enforcement.");
  if (result.verdict === "BLOCK") {
    lines.push("Do not retry this change. Ask a human, or propose a safer alternative.");
  }

  return lines.join("\n");
}

/**
 * The answer as an agent reads it.
 *
 * The permalinks are the load-bearing part. An agent relaying this to a human
 * is the only thing standing between "the notes say X" and a person able to
 * check whether they do, and a summary of a summary with the links stripped is
 * unfalsifiable by the time it reaches them. So every source is listed with its
 * URL, whether or not the model cited it — the same rule the REST route
 * follows.
 *
 * The unsupported and no-sources cases are stated as answers rather than
 * errors, because they are. An agent handed "no sources" as a tool failure
 * retries, then starts filling the gap from its own background knowledge about
 * organisations in general, which is precisely the fabrication the grounding
 * prompt exists to prevent.
 */
export function renderAskText(answer: AskAnswer, question: string): string {
  if (answer.sources.length === 0) return answer.answer;

  const lines: string[] = [];
  if (answer.unavailable) {
    lines.push(answer.unavailable);
    lines.push(
      "",
      `No answer was written. Read the passages below and answer from them, or tell your human the model is unavailable. Do not answer "${question}" from your own knowledge.`,
    );
  } else {
    lines.push(answer.answer);
  }

  lines.push("", "Sources:");
  for (const source of answer.sources) {
    const when = source.occurredAt
      ? source.occurredAt.toISOString().slice(0, 10)
      : "undated";
    const who = source.speaker ? `, ${source.speaker}` : "";
    lines.push(`  [${source.n}] ${source.title} (${when}${who}) ${source.permalink}`);
    lines.push(`      ${source.excerpt.replace(/\s+/g, " ")}`);
  }

  lines.push(
    "",
    "Every claim above comes from these passages and nothing else. Keep the citations when you relay this.",
  );

  return lines.join("\n");
}

/**
 * Ask a question in prose and get an answer grounded in this org's documents.
 *
 * Hybrid retrieval — lexical and vector, fused by rank — then a model that is
 * only allowed to speak from what it retrieved. The agent gets prose plus the
 * links, so it never has to guess and its human never has to take its word.
 */
export async function askDocs(ctx: McpContext, input: z.infer<typeof askDocsInput>) {
  const answer = await askDocuments(ctx.orgId, input.question);

  return {
    structured: {
      answer: answer.answer,
      grounded: answer.grounded,
      unavailable: answer.unavailable ?? null,
      sources: answer.sources.map((source) => ({
        n: source.n,
        title: source.title,
        speaker: source.speaker,
        permalink: source.permalink,
        occurred_at: source.occurredAt?.toISOString() ?? null,
        excerpt: source.excerpt,
      })),
    },
    text: renderAskText(answer, input.question),
  };
}

export async function proposeChange(
  ctx: McpContext,
  input: z.infer<typeof proposeChangeInput>,
) {
  const change = {
    ...input.change,
    // Fill the agent name from the MCP client when the caller omits it.
    agent: input.change.agent ?? ctx.clientName ?? "mcp-client",
  };

  const outcome = await decide(change, {
    orgId: ctx.orgId,
    mode: "mcp",
    dryRun: input.dry_run,
    actor: `agent:${change.agent}`,
    apiKeyId: ctx.apiKeyId,
  });

  return {
    structured: {
      decision_id: outcome.decisionId,
      verdict_id: outcome.verdictId,
      verdict: outcome.result.verdict,
      evidence: outcome.result.evidence,
      impacted: outcome.result.impacted.slice(0, 20),
      computed_in_ms: outcome.result.computedInMs,
      executed: false,
    },
    text: renderVerdictText(outcome.result, input.dry_run),
  };
}

export async function queryBlastRadius(
  ctx: McpContext,
  input: z.infer<typeof nodeRefInput>,
) {
  const rows = await blastRadius(ctx.orgId, {
    target: "field",
    operation: "delete",
    connector: input.connector as "postgres",
    externalId: input.externalId,
  });
  return {
    structured: { impacted: rows },
    text:
      rows.length === 0
        ? "Nothing depends on that node."
        : rows
            .slice(0, 15)
            .map(
              (r) =>
                `${r.name} (${r.kind}) impact ${r.impact.toFixed(2)}, ${r.hops} hop(s)`,
            )
            .join("\n"),
  };
}

export async function getNode(ctx: McpContext, input: z.infer<typeof nodeRefInput>) {
  const node = await resolveNode(ctx.orgId, {
    target: "field",
    operation: "delete",
    connector: input.connector as "postgres",
    externalId: input.externalId,
  });
  if (!node) return { structured: { found: false }, text: "No such node in this graph." };

  const [full] = await db
    .select()
    .from(nodesTable)
    .where(eq(nodesTable.id, node.id))
    .limit(1);

  const directEdges = await db
    .select({
      id: edgesTable.id,
      srcId: edgesTable.srcId,
      dstId: edgesTable.dstId,
      kind: edgesTable.kind,
      confidence: edgesTable.confidence,
      provenance: edgesTable.provenance,
    })
    .from(edgesTable)
    .where(
      and(
        eq(edgesTable.orgId, ctx.orgId),
        or(eq(edgesTable.srcId, node.id), eq(edgesTable.dstId, node.id)),
      ),
    )
    .limit(50);

  const edgeIds = directEdges.map((e) => e.id);
  const linked =
    edgeIds.length === 0
      ? []
      : await db
          .select({
            body: rationale.body,
            sourceUrl: rationale.sourceUrl,
            author: rationale.author,
          })
          .from(rationale)
          .innerJoin(rationaleLinks, eq(rationaleLinks.rationaleId, rationale.id))
          .where(
            and(
              eq(rationale.orgId, ctx.orgId),
              eq(rationale.state, "confirmed"),
              // The join was unconstrained, so this returned any confirmed
              // rationale in the org and the caller presented it as the
              // rationale for *this* node: a real author and a real permalink
              // attached to a claim they never made about it.
              inArray(rationaleLinks.edgeId, edgeIds),
            ),
          )
          .orderBy(desc(rationale.confirmedAt))
          .limit(10);

  return {
    structured: { found: true, node: full, edges: directEdges, rationale: linked },
    text: [
      `${full?.name} (${full?.kind}) criticality ${full?.criticality}`,
      `${directEdges.length} direct edges`,
      ...linked.map(
        (r) => `"${r.body.slice(0, 160)}" — ${r.author ?? "unknown"} ${r.sourceUrl}`,
      ),
    ].join("\n"),
  };
}
