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
      const hits = await searchSlack(ctx, String(args.query));
      for (const hit of hits) {
        ctx.seenUrls.add(hit.permalink);
        ctx.seenContent.set(hit.permalink, hit.text);
      }
      return { terminal: false, output: { hits } };
    }

    case "search_github": {
      const hits = await searchGithub(
        ctx,
        String(args.query),
        args.kind as "pr" | "commit",
      );
      for (const hit of hits) {
        ctx.seenUrls.add(hit.url);
        ctx.seenContent.set(hit.url, hit.snippet);
      }
      return { terminal: false, output: { hits } };
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
      for (const message of thread.messages) {
        ctx.seenUrls.add(message.permalink);
        ctx.seenContent.set(message.permalink, message.text);
      }
      return { terminal: false, output: thread };
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

interface ProposeArgs {
  text: string;
  source_url: string;
  author: string;
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

  // Dedupe: an existing rationale on the same URL gets linked, not duplicated.
  const [existing] = await db
    .select({ id: rationale.id })
    .from(rationale)
    .where(and(eq(rationale.orgId, ctx.orgId), eq(rationale.sourceUrl, args.source_url)))
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
        confidence: args.confidence,
        // Drafted, always. Only a human with `rationale:confirm` moves the
        // coverage metric — that is the invariant, as executable code.
        state: "drafted",
        embedding: null,
      })
      .returning({ id: rationale.id });
    rationaleId = row?.id;
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
