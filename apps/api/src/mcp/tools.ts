import {
  edges as edgesTable,
  nodes as nodesTable,
  rationale,
  rationaleLinks,
} from "@sadhak/shared/schema";
import { changeDescriptorSchema, type VerdictResult } from "@sadhak/shared/types";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { auditActor } from "../audit.js";
import { db } from "../db.js";
import { type AskAnswer, askDocuments } from "../documents/ask.js";
import { assertAcceptedName, uploadDocument } from "../documents/ingest.js";
import { documentPermalink } from "../documents/retrieve.js";
import { decide } from "../gate/decide.js";
import { blastRadius, resolveNode } from "../sentinel/verdict.js";

/**
 * The tools an agent runtime sees. Thin adapters over the exact functions the
 * REST route calls, with the exact zod schemas from the shared package — so
 * REST and MCP cannot drift.
 */

/**
 * Every `.describe()` below is published verbatim in the tool's JSON Schema by
 * `mcp/registry.ts`, so the prose an agent reads and the rule the parser
 * enforces are the same string. Describing a field here is the only way to
 * document it; there is no second, hand-written copy to fall out of step.
 */
export const proposeChangeInput = z.object({
  /**
   * A discriminated union on `target`, published as its three real branches
   * rather than as an opaque object. The vocabulary is the point: `connector`
   * is not free text, and which operations are legal depends on `target` —
   * a workflow can be disabled, a field cannot.
   */
  change: changeDescriptorSchema.describe(
    'The change you want to make, discriminated by "target". ' +
      'target="field" takes operation delete|rename|retype on connector airtable|postgres; ' +
      'target="workflow" takes operation modify|disable|delete on connector n8n; ' +
      'target="credential" takes operation revoke on any connector. ' +
      "externalId is the identifier in that system, not a display name.",
  ),
  dry_run: z
    .boolean()
    .default(false)
    .describe(
      "Simulate without recording enforcement. The verdict is computed identically; only the audit trail differs. Use true when you are exploring, false when you are actually about to act.",
    ),
});

export const nodeRefInput = z.object({
  connector: z
    .enum(["n8n", "airtable", "postgres", "github", "slack"])
    .describe("Which connected system the node lives in."),
  externalId: z
    .string()
    .min(1)
    .describe(
      "The node's address as the crawler recorded it, which is path-shaped and not the node's display name. " +
        "postgres: <connectorInstanceId>/db/<database>/column/<schema>.<table>.<column> — also .../table/<schema>.<name> and .../view/<schema>.<name>. " +
        "airtable: base/<id>, table/<id>, field/<id>. " +
        "n8n: workflow/<id>, workflow/<id>/node/<nodeId>, credential/<id>. " +
        "If you do not already have this exact string, do not guess it — a near miss resolves to nothing rather than to something close. Ask ask_docs, or read it off a previous verdict or blast-radius result, which carry it.",
    ),
});

/** The same bounds as `POST /ask`, for the same reasons: below three
 * characters there is nothing to retrieve on, and above five hundred the
 * caller is pasting a document rather than asking about one. */
export const askDocsInput = z.object({
  question: z
    .string()
    .min(3)
    .max(500)
    .describe(
      'A specific question in prose, e.g. "why did we stop syncing the vat_rate field?". Retrieval is hybrid lexical and semantic, so an exact identifier and a description of one both work. Ask one question at a time; a compound question retrieves for neither half well.',
    ),
});

/**
 * The same fields `POST /documents` accepts, in MCP's snake_case.
 *
 * `source` is the field with no REST equivalent, and it is the reason this
 * schema is not just the upload schema renamed. Text an agent read off a
 * photograph of a whiteboard is a transcription, not a copy: it can drop a
 * line, misread a name, or quietly smooth an ambiguity into a decision nobody
 * made. That difference has to survive ingestion, because a citation pointing
 * into such a document looks exactly like a citation into a pasted transcript
 * once it is a chunk in a search result.
 */
export const ingestDocumentInput = z.object({
  title: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'What this document is, e.g. "Billing sync handover, 11 Mar". Shown in the document list and in every citation that points at it, so name it the way someone searching a year from now would.',
    ),
  text: z
    .string()
    .min(1)
    .describe(
      'The full text. Keep "Speaker: line" turns on their own lines and VTT/SRT cues intact — chunking splits on those boundaries, and losing them costs per-speaker attribution in every later citation.',
    ),
  /** When the meeting happened. Not when it was ingested. */
  occurred_at: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      "ISO 8601 timestamp with offset for when the meeting happened — not when you are storing it. Omit it rather than guessing; an invented date makes a stale note look current.",
    ),
  source: z
    .enum(["pasted_text", "image"])
    .default("pasted_text")
    .describe(
      'Where the text came from. Use "image" whenever you produced it by reading a photograph, screenshot, whiteboard or slide rather than copying text you were given. It is recorded on the document so a later reader can weigh a transcription differently from a verbatim copy.',
    ),
  original_name: z
    .string()
    .max(300)
    .optional()
    .describe(
      "The source filename if there was one. Text extensions only (.txt, .md, .vtt, .srt). Omit it for a paste rather than inventing one.",
    ),
  source_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Where the document came from, for provenance. Citations never point here; they point at the stored copy.",
    ),
});

/* ------------------------------------------------------------------ output */

/**
 * What each tool promises to put in `structuredContent`.
 *
 * Deliberately precise at the top level and permissive underneath. The top
 * level is this module's own contract and is worth pinning; the nested rows are
 * verdict evidence and graph nodes owned by other modules, and restating their
 * shape here would create a second definition that goes stale the first time
 * one of them gains a column — turning an additive change into a schema
 * violation for callers who never read the field.
 */
export const proposeChangeOutput = z.object({
  decision_id: z.unknown(),
  verdict_id: z.unknown(),
  verdict: z.enum(["BLOCK", "WARN", "APPROVE"]),
  evidence: z.array(z.unknown()),
  impacted: z.array(z.unknown()),
  computed_in_ms: z.number(),
  /** Always false. This server decides; it never performs the change. */
  executed: z.literal(false),
});

export const blastRadiusOutput = z.object({ impacted: z.array(z.unknown()) });

export const getNodeOutput = z.object({
  found: z.boolean(),
  node: z.unknown().optional(),
  edges: z.array(z.unknown()).optional(),
  rationale: z.array(z.unknown()).optional(),
});

export const askDocsOutput = z.object({
  answer: z.string(),
  grounded: z.boolean(),
  unavailable: z.string().nullable(),
  sources: z.array(
    z.object({
      n: z.number(),
      /** Which corpus. A thread and a minuted decision carry different
       * weight, and an undifferentiated list hides that. */
      kind: z.enum(["document", "slack"]),
      title: z.string(),
      speaker: z.string().nullable(),
      permalink: z.string(),
      occurred_at: z.string().nullable(),
      excerpt: z.string(),
    }),
  ),
  /** Corpora that could not be consulted, said out loud rather than
   * silently omitted. */
  notes: z.array(z.string()),
});

export const ingestDocumentOutput = z.object({
  document_id: z.number(),
  title: z.string(),
  chunk_count: z.number(),
  duplicate: z.boolean(),
  source: z.enum(["pasted_text", "image"]),
  permalink: z.string(),
});

/**
 * Who is calling, reduced to what every tool needs.
 *
 * Exactly one of `apiKeyId` and `userId` is set: an API key is the
 * organisation's own credential, an OAuth grant belongs to a person who let a
 * client act as them. The distinction never reaches a capability check —
 * `scopes` is the same array either way — but it must reach the audit log,
 * because "an agent holding Priya's grant added this document" and "an agent
 * holding the org's key added this document" are different facts about who to
 * ask.
 */
export interface McpContext {
  orgId: number;
  apiKeyId?: number | undefined;
  userId?: number | undefined;
  scopes: string[];
  clientName?: string | undefined;
}

/** `api_key:12` or `user:7` — whichever credential actually arrived. */
export function actorRef(ctx: McpContext): string {
  return ctx.apiKeyId ? `api_key:${ctx.apiKeyId}` : `user:${ctx.userId ?? 0}`;
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
  /**
   * The notes survive even the no-sources case, and that is the case they
   * matter most in.
   *
   * "Nothing covers that" and "nothing covers that, and by the way Slack was
   * never searched because no channel is connected" are different answers, and
   * an agent handed the first will report a confident absence to its human.
   * The second tells it what to go and fix.
   */
  const notes = answer.notes ?? [];
  const noteBlock =
    notes.length > 0
      ? ["", "Caveats on what was searched:", ...notes.map((n) => `  - ${n}`)]
      : [];

  if (answer.sources.length === 0) {
    return [answer.answer, ...noteBlock].join("\n");
  }

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
    // A written document and a line in a channel are not equally settled, and
    // the numbered list is the only place a relaying agent can see which it is.
    const kind = source.kind === "slack" ? "Slack message" : "document";
    lines.push(
      `  [${source.n}] (${kind}) ${source.title} (${when}${who}) ${source.permalink}`,
    );
    lines.push(`      ${source.excerpt.replace(/\s+/g, " ")}`);
  }

  lines.push(...noteBlock);

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
        kind: source.kind,
        title: source.title,
        speaker: source.speaker,
        permalink: source.permalink,
        occurred_at: source.occurredAt?.toISOString() ?? null,
        excerpt: source.excerpt,
      })),
      // Always an array, never absent. An optional field that means "a corpus
      // was skipped" is one a caller forgets to check exactly when it matters.
      notes: answer.notes ?? [],
    },
    text: renderAskText(answer, input.question),
  };
}

/**
 * Who to credit for an ingested document, within the column's 200 characters.
 *
 * The transcription case is spelled out in words rather than encoded, because
 * the audience is whoever opens the document page after following a citation
 * into it, and `source=image` means nothing to them. "read from an image by
 * claude, not a verbatim copy" tells them exactly how much to trust a sentence
 * that looks like a quote.
 */
export function ingestedByLabel(
  ctx: McpContext,
  source: "pasted_text" | "image",
): string {
  const client = (ctx.clientName ?? "an MCP client").slice(0, 60);
  const via = `${actorRef(ctx)} via ${client}`;
  return source === "image"
    ? `${via} (read from an image by ${client}, not a verbatim copy)`.slice(0, 200)
    : via.slice(0, 200);
}

/**
 * What the agent is told after a document lands.
 *
 * The duplicate case says plainly that nothing was written, so an agent does
 * not report a successful upload twice or retry to "make sure". The embedding
 * delay is stated because the agent's very next instinct is to search for what
 * it just ingested, find it ranked by text alone, and conclude the ingest
 * failed.
 */
export function renderIngestText(
  result: { id: number; title: string; chunkCount: number; duplicate: boolean },
  source: "pasted_text" | "image",
): string {
  if (result.duplicate) {
    return [
      `Already stored — nothing was written. "${result.title}" is document ${result.id} and its existing copy is unchanged.`,
      "Do not retry this ingest. If you meant to store a revised version, change the text or give it its own title.",
    ].join("\n");
  }

  const lines = [
    `Stored "${result.title}" as document ${result.id}, in ${result.chunkCount} chunk(s).`,
    "Text search finds it now; semantic search follows within about a minute, once the embedding worker catches up.",
  ];

  if (source === "image") {
    lines.push(
      "Recorded as read from an image rather than pasted verbatim, so anyone citing it later can see that. Tell your human the same thing.",
    );
  }

  return lines.join("\n");
}

/**
 * Ingest a transcript or note through the exact path an upload takes.
 *
 * The entire body of this function is argument translation. Normalising,
 * chunking, hashing, the transaction, the embed enqueue and the size limit all
 * belong to `uploadDocument`, and reimplementing any of them here would mean
 * a document ingested by an agent chunked differently from the same text
 * uploaded by a human — with retrieval quietly better or worse depending on
 * which door the text came through.
 */
export async function ingestDocument(
  ctx: McpContext,
  input: z.infer<typeof ingestDocumentInput>,
) {
  // Only when a filename is given. A pasted transcript has no extension and
  // should not need an invented one.
  if (input.original_name) assertAcceptedName(input.original_name);

  const result = await uploadDocument({
    orgId: ctx.orgId,
    title: input.title,
    text: input.text,
    ...(input.original_name ? { originalName: input.original_name } : {}),
    ...(input.occurred_at ? { occurredAt: new Date(input.occurred_at) } : {}),
    ...(input.source_url ? { sourceUrl: input.source_url } : {}),
    uploadedBy: ingestedByLabel(ctx, input.source),
  });

  /**
   * `uploadDocument` already writes a `system` audit row. This one carries the
   * key that actually did it — an org reading its own audit log needs to see
   * that an agent added a document, not that "the system" did.
   */
  if (!result.duplicate) {
    await auditActor(
      "document.uploaded",
      ctx.orgId,
      ctx.apiKeyId
        ? { type: "api_key", id: ctx.apiKeyId }
        : { type: "user", id: ctx.userId ?? 0 },
      { kind: "document", id: result.id },
      {
        title: result.title,
        chunks: result.chunkCount,
        source: input.source,
        mcpClient: ctx.clientName ?? null,
      },
    );
  }

  return {
    structured: {
      document_id: result.id,
      title: result.title,
      chunk_count: result.chunkCount,
      duplicate: result.duplicate,
      source: input.source,
      permalink: documentPermalink(result.id),
    },
    text: renderIngestText(result, input.source),
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
    apiKeyId: ctx.apiKeyId ?? null,
  });

  return {
    structured: {
      decision_id: outcome.decisionId,
      verdict_id: outcome.verdictId,
      verdict: outcome.result.verdict,
      evidence: outcome.result.evidence,
      impacted: outcome.result.impacted.slice(0, 20),
      computed_in_ms: outcome.result.computedInMs,
      // `as const` so the type is the literal `false` the output schema
      // declares, rather than widening to boolean — this server decides and
      // never executes, and that is a promise worth holding in the type.
      executed: false as const,
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
