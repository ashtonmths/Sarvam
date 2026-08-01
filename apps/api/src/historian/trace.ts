import { agentTraces } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";

/**
 * Every tool call persists, including terminals and synthetic ones, because
 * the reasoning path is a product surface and not just a log.
 *
 * Traces are pointers too, not channel archives: snippets are capped so a
 * trace never becomes a copy of someone's Slack history.
 */

const SNIPPET_CAP = 500;

interface TraceCtx {
  orgId: number;
  runId: string;
}

function cap(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, SNIPPET_CAP);
  if (Array.isArray(value)) return value.slice(0, 10).map(cap);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cap(v)]),
    );
  }
  return value;
}

export async function trace(
  ctx: TraceCtx,
  step: number,
  tool: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): Promise<void> {
  await db.insert(agentTraces).values({
    orgId: ctx.orgId,
    runId: ctx.runId,
    agent: "historian",
    step,
    tool,
    input: cap(input) as Record<string, unknown>,
    output: cap(output) as Record<string, unknown>,
  });
}

/**
 * A failed parse gets its own row with the raw output, so a reviewer can see
 * *why* an edge came back unexplained rather than guessing.
 */
export async function traceParseFailure(
  ctx: TraceCtx,
  step: number,
  raw: string | null,
): Promise<void> {
  await db.insert(agentTraces).values({
    orgId: ctx.orgId,
    runId: ctx.runId,
    agent: "historian",
    step,
    tool: "parse_failure",
    input: {},
    output: { raw: (raw ?? "").slice(0, SNIPPET_CAP) },
  });
}

export async function traceSteps(orgId: number, runId: string) {
  return db
    .select()
    .from(agentTraces)
    .where(and(eq(agentTraces.orgId, orgId), eq(agentTraces.runId, runId)))
    .orderBy(agentTraces.step);
}
