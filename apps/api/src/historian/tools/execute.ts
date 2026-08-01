import {
  edges as edgesTable,
  miningScopes,
  nodes as nodesTable,
  rationale,
  rationaleLinks,
} from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { enqueue } from "../../jobs/queue.js";
import type { LoopOutcome } from "../loop.js";
import { type ToolName, toolArgSchemas } from "./defs.js";
import { searchGithub } from "./github.js";
import { readThread, searchSlack } from "./slack.js";

/**
 * Tool execution, with the anti-confabulation checks that make a fabricated
 * citation *unrepresentable* rather than merely discouraged.
 */

export interface LoopCtx {
  orgId: number;
  edgeId: number;
  /** URLs the model has actually been shown this run. */
  seenUrls: Set<string>;
  /** Raw content behind each seen URL, for the containment check. */
  seenContent: Map<string, string>;
  signal?: AbortSignal | undefined;
}

export type ToolResult =
  | { terminal: false; output: Record<string, unknown> }
  | { terminal: true; outcome: LoopOutcome; output: Record<string, unknown> };

export async function executeTool(
  name: ToolName,
  rawArgs: Record<string, unknown>,
  ctx: LoopCtx,
): Promise<ToolResult> {
  const schema = toolArgSchemas[name];
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      terminal: false,
      output: { error: `Invalid arguments for ${name}: ${parsed.error.message}` },
    };
  }
  const args = parsed.data as Record<string, unknown>;

  switch (name) {
    case "get_edge_context":
      return { terminal: false, output: await edgeContext(ctx) };

    case "search_slack": {
      const all = await searchSlack(ctx, String(args.query));
      const { kept, dropped } = fitItems(all);
      for (const hit of kept) {
        ctx.seenUrls.add(hit.permalink);
        ctx.seenContent.set(hit.permalink, hit.text);
      }
      return { terminal: false, output: withOmitted({ hits: kept }, dropped) };
    }

    case "search_github": {
      const all = await searchGithub(
        ctx,
        String(args.query),
        args.kind as "pr" | "commit",
      );
      const { kept, dropped } = fitItems(all);
      for (const hit of kept) {
        ctx.seenUrls.add(hit.url);
        ctx.seenContent.set(hit.url, hit.snippet);
      }
      return { terminal: false, output: withOmitted({ hits: kept }, dropped) };
    }

    case "read_thread": {
      const permalink = String(args.permalink);
      // Must be a URL previously returned this run: the model cannot read what
      // it did not find.
      if (!ctx.seenUrls.has(permalink)) {
        return {
          terminal: false,
          output: { error: "That permalink was not returned by a tool in this run." },
        };
      }
      const thread = await readThread(ctx, permalink);
      /**
       * Threads are kept newest-last but trimmed from the *front*: Slack
       * returns replies oldest first, and the decision a thread reaches is at
       * the end. Cutting the tail removed precisely the part worth reading.
       */
      const { kept, dropped } = fitItems(thread.messages, "front");
      for (const message of kept) {
        ctx.seenUrls.add(message.permalink);
        ctx.seenContent.set(message.permalink, message.text);
      }
      return { terminal: false, output: withOmitted({ messages: kept }, dropped) };
    }

    case "propose_rationale":
      return proposeRationale(ctx, args as unknown as ProposeArgs);

    case "give_up": {
      const reason = String(args.reason);
      return {
        terminal: true,
        outcome: { kind: "gave_up", reason },
        output: { reason },
      };
    }

    default:
      return { terminal: false, output: { error: `Unknown tool: ${name}` } };
  }
}

/**
 * The budget a single tool result may occupy in the conversation.
 *
 * The loop used to hand the model `JSON.stringify(output).slice(0, 4000)`,
 * which cut mid-string into invalid JSON and, on a long thread, delivered the
 * first few messages of forty. Worse, every item was registered in
 * `seenContent` before that cut, so the containment check in
 * `propose_rationale` would happily accept a quote from a message the model
 * was never shown — the one guard against confabulation, validating against
 * text that was not in the context.
 *
 * Budgeting here instead keeps "what the model saw" and "what it may quote"
 * the same set, by construction.
 */
const OUTPUT_BUDGET_BYTES = 3600;

export function fitItems<T>(
  items: T[],
  trim: "front" | "back" = "back",
): { kept: T[]; dropped: number } {
  const kept = [...items];
  while (kept.length > 0 && JSON.stringify(kept).length > OUTPUT_BUDGET_BYTES) {
    if (trim === "front") kept.shift();
    else kept.pop();
  }
  return { kept, dropped: items.length - kept.length };
}

/**
 * Says so when something was left out. Silence would read as "that is all
 * there was", and the model would give up on a thread it never fully saw.
 */
function withOmitted<T extends Record<string, unknown>>(
  output: T,
  dropped: number,
): T | (T & { omitted: string }) {
  if (dropped === 0) return output;
  return {
    ...output,
    omitted: `${dropped} more result(s) were not shown because the response was too long. What you can see is complete and quotable; narrow your query if you need the rest.`,
  };
}

interface ProposeArgs {
  text: string;
  source_url: string;
  author: string;
  /** ISO-8601 from the tool that returned the message. Optional by design. */
  authored_at?: string;
  confidence: number;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Three checks, all server-side, all before any insert:
 *   1. the URL was retrieved this run
 *   2. it resolves inside the org's mining scopes
 *   3. the quoted span actually appears in that source
 *
 * A failed check returns a tool error rather than crashing the loop — the
 * model may retry with an honest citation, or give up.
 */
async function proposeRationale(ctx: LoopCtx, args: ProposeArgs): Promise<ToolResult> {
  if (!ctx.seenUrls.has(args.source_url)) {
    return {
      terminal: false,
      output: {
        error:
          "You may only cite a source_url returned to you by a tool in this run. Search first, then cite what you found.",
      },
    };
  }

  const inScope = await urlInScope(ctx.orgId, args.source_url);
  if (!inScope) {
    return {
      terminal: false,
      output: { error: "That source is outside this organization's mining scopes." },
    };
  }

  const source = ctx.seenContent.get(args.source_url) ?? "";
  if (!normalize(source).includes(normalize(args.text))) {
    return {
      terminal: false,
      output: {
        error:
          "That text does not appear in the source you cited. Quote the span verbatim, or give_up.",
      },
    };
  }

  /**
   * Dedupe on the quoted span, not on the URL alone.
   *
   * Keying on the URL meant the second edge to cite a thread was linked to
   * whatever span the *first* edge's model had chosen, and its own `text` was
   * dropped on the floor. One Slack thread routinely explains two different
   * dependencies, so edge B ended up justified by a sentence about edge A —
   * and that sentence is what a Check Run prints as the reason for a block.
   *
   * The insert is conflict-tolerant rather than guarded by the select above:
   * a run fans out concurrent loops, and two of them citing the same span at
   * once would otherwise both find nothing and both insert.
   */
  const [existing] = await db
    .select({ id: rationale.id })
    .from(rationale)
    .where(
      and(
        eq(rationale.orgId, ctx.orgId),
        eq(rationale.sourceUrl, args.source_url),
        eq(rationale.body, args.text),
      ),
    )
    .limit(1);

  let rationaleId = existing?.id;

  if (!rationaleId) {
    const [row] = await db
      .insert(rationale)
      .values({
        orgId: ctx.orgId,
        body: args.text,
        sourceKind: args.source_url.includes("github.com") ? "pr" : "slack",
        sourceUrl: args.source_url,
        author: args.author,
        authoredAt: args.authored_at ? new Date(args.authored_at) : null,
        confidence: args.confidence,
        // Drafted, always. Only a human with `rationale:confirm` moves the
        // coverage metric — that is the invariant, as executable code.
        state: "drafted",
        embedding: null,
      })
      .onConflictDoNothing()
      .returning({ id: rationale.id });
    rationaleId = row?.id;

    // Lost the race: the row exists now, so read the winner's id.
    if (!rationaleId) {
      const [raced] = await db
        .select({ id: rationale.id })
        .from(rationale)
        .where(
          and(
            eq(rationale.orgId, ctx.orgId),
            eq(rationale.sourceUrl, args.source_url),
            eq(rationale.body, args.text),
          ),
        )
        .limit(1);
      rationaleId = raced?.id;
    }
  }

  if (!rationaleId) {
    return { terminal: false, output: { error: "Could not store the rationale." } };
  }

  await db
    .insert(rationaleLinks)
    .values({ rationaleId, edgeId: ctx.edgeId })
    .onConflictDoNothing();

  await enqueue(
    "rationale.embed",
    {},
    { orgId: ctx.orgId, dedupeKey: "rationale.embed" },
  );

  return {
    terminal: true,
    outcome: { kind: "proposed", rationaleId },
    output: { rationaleId, state: "drafted", sourceUrl: args.source_url },
  };
}

async function urlInScope(orgId: number, url: string): Promise<boolean> {
  const scopes = await db
    .select({ connector: miningScopes.connector, value: miningScopes.scopeValue })
    .from(miningScopes)
    .where(eq(miningScopes.orgId, orgId));

  if (scopes.length === 0) return false;

  return scopes.some((scope) => {
    if (scope.connector === "github") return url.includes(scope.value);
    // Slack permalinks carry the channel id in the archives path.
    if (scope.connector === "slack") return url.includes(scope.value);
    return false;
  });
}

async function edgeContext(ctx: LoopCtx): Promise<Record<string, unknown>> {
  const [edge] = await db
    .select()
    .from(edgesTable)
    .where(and(eq(edgesTable.id, ctx.edgeId), eq(edgesTable.orgId, ctx.orgId)))
    .limit(1);
  if (!edge) return { error: "Edge not found" };

  const [src] = await db
    .select()
    .from(nodesTable)
    .where(eq(nodesTable.id, edge.srcId))
    .limit(1);
  const [dst] = await db
    .select()
    .from(nodesTable)
    .where(eq(nodesTable.id, edge.dstId))
    .limit(1);

  const linked = await db
    .select({
      body: rationale.body,
      sourceUrl: rationale.sourceUrl,
      state: rationale.state,
    })
    .from(rationale)
    .innerJoin(rationaleLinks, eq(rationaleLinks.rationaleId, rationale.id))
    .where(and(eq(rationaleLinks.edgeId, ctx.edgeId), eq(rationale.orgId, ctx.orgId)))
    .limit(5);

  return {
    edge: { kind: edge.kind, provenance: edge.provenance, confidence: edge.confidence },
    src: src ? { name: src.name, kind: src.kind, criticality: src.criticality } : null,
    dst: dst ? { name: dst.name, kind: dst.kind, criticality: dst.criticality } : null,
    existingRationale: linked,
  };
}
