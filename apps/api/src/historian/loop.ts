import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { complete, LlmQuotaExhaustedError, type Message, type Usage } from "../llm.js";
import {
  HISTORIAN_PROMPT,
  TOOL_DEFS,
  TOOL_ENVELOPE,
  type ToolName,
} from "./tools/defs.js";
import { executeTool, type LoopCtx, type ToolResult } from "./tools/execute.js";
import { trace, traceParseFailure } from "./trace.js";

/**
 * The loop is deliberately boring — the intelligence is in the tools and the
 * terminal discipline.
 *
 * `give_up` is a first-class terminal, which is the whole point: an agent with
 * an honourable exit takes it instead of confabulating. There is **no code
 * path** where a parse failure is smoothed into a `propose_rationale` with a
 * reconstructed citation.
 */

export interface EdgeGoal {
  edgeId: number;
  srcName: string;
  dstName: string;
  edgeKind: string;
}

export type LoopOutcome =
  | { kind: "proposed"; rationaleId: number }
  | { kind: "gave_up"; reason: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

interface ParsedCall {
  tool: ToolName;
  args: Record<string, unknown>;
  id: string;
}

/**
 * Backstop only. Sits above executeTool's own per-result budget so that in
 * normal operation nothing reaches it.
 */
const MAX_TOOL_RESULT_BYTES = 8000;

/**
 * Reads the structured-output envelope first and native tool calls second.
 *
 * Free models are small models: of the 14 `:free` slugs only 4 support
 * structured outputs, and providers rotate and re-serve them, so
 * `response_format` can silently degrade to plain text. The floor is a strict
 * JSON text protocol — strip fences, take the first balanced object.
 */
export function parseCall(input: {
  content: string | null;
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
}): ParsedCall | null {
  const envelope = parseEnvelope(input.content);
  if (envelope) return envelope;

  const native = input.toolCalls[0];
  if (native) {
    try {
      return {
        tool: native.function.name as ToolName,
        args: JSON.parse(native.function.arguments || "{}") as Record<string, unknown>,
        id: native.id,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function parseEnvelope(content: string | null): ParsedCall | null {
  if (!content) return null;

  const stripped = content
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const start = stripped.indexOf("{");
  if (start === -1) return null;

  // First balanced object — models like to add a sentence afterwards.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i += 1) {
    const char = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(stripped.slice(start, i + 1)) as {
            tool?: string;
            args?: Record<string, unknown>;
          };
          if (!parsed.tool) return null;
          return {
            tool: parsed.tool as ToolName,
            args: parsed.args ?? {},
            id: randomUUID(),
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface Budget {
  hasHeadroom(): Promise<boolean>;
  record(usage: Usage): Promise<void>;
}

export interface RunContext extends LoopCtx {
  runId: string;
  stepBudget: number;
  maxParseFailures: number;
  budget: Budget;
  cancelled: () => Promise<boolean>;
}

export async function runLoop(goal: EdgeGoal, ctx: RunContext): Promise<LoopOutcome> {
  const messages: Message[] = [
    { role: "system", content: HISTORIAN_PROMPT },
    { role: "user", content: renderGoal(goal) },
  ];
  let failures = 0;

  for (let step = 1; step <= ctx.stepBudget; step += 1) {
    if (await ctx.cancelled()) {
      await trace(ctx, step, "cancelled", {}, { cancelled: true });
      return { kind: "cancelled" };
    }

    if (!(await ctx.budget.hasHeadroom())) {
      const reason = "org budget exhausted";
      await trace(ctx, step, "give_up", { reason }, { reason });
      return { kind: "gave_up", reason };
    }

    let content: string | null;
    let toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;

    try {
      const completion = await complete({
        tier: "strong",
        caller: "historian.mine_edge",
        orgId: ctx.orgId,
        messages,
        tools: TOOL_DEFS,
        toolChoice: "required",
        responseFormat: TOOL_ENVELOPE,
      });
      await ctx.budget.record(completion.usage);
      content = completion.content;
      toolCalls = completion.toolCalls;
    } catch (error) {
      // A wall that stays up for hours is not something to retry into.
      if (error instanceof LlmQuotaExhaustedError) {
        const reason = "daily model quota exhausted";
        await trace(ctx, step, "give_up", { reason }, { reason, resetAt: error.resetAt });
        return { kind: "gave_up", reason };
      }
      const message = error instanceof Error ? error.message : String(error);
      await trace(ctx, step, "error", {}, { message });
      return { kind: "error", message };
    }

    const call = parseCall({ content, toolCalls });

    if (!call) {
      // A malformed model is a model burning quota. The repair turn costs a
      // step and a request like any other call, so the budget feels the waste.
      await traceParseFailure(ctx, step, content);
      failures += 1;
      if (failures >= ctx.maxParseFailures) {
        const reason = "model output unparseable";
        await trace(ctx, step, "give_up", { reason }, { reason });
        return { kind: "gave_up", reason };
      }
      messages.push({ role: "assistant", content: content ?? "" });
      messages.push({
        role: "user",
        content: `That was not valid JSON matching the required envelope. Reply with exactly one JSON object, no prose and no code fences, matching: ${JSON.stringify(TOOL_ENVELOPE.json_schema.schema)}`,
      });
      continue;
    }

    const result: ToolResult = await executeTool(call.tool, call.args, ctx);
    await trace(ctx, step, call.tool, call.args, result.output);

    if (result.terminal) return result.outcome;

    /**
     * Tool results are budgeted where they are built, in executeTool, so that
     * what the model is shown and what it is allowed to quote are the same
     * set. This is only a backstop for an output that budgeting does not cover
     * — and it replaces the payload rather than cutting it, because half a
     * JSON document is worse than none: the model reads the fragment as
     * complete and reasons from it.
     */
    const serialized = JSON.stringify(result.output);
    messages.push({
      role: "assistant",
      content: JSON.stringify({ tool: call.tool, args: call.args }),
    });
    messages.push({
      role: "user",
      content:
        serialized.length <= MAX_TOOL_RESULT_BYTES
          ? serialized
          : JSON.stringify({
              error: "That result was too large to show. Narrow the query and try again.",
            }),
    });
  }

  const reason = "step budget exhausted";
  await trace(ctx, ctx.stepBudget + 1, "give_up", { reason }, { reason });
  return { kind: "gave_up", reason };
}

function renderGoal(goal: EdgeGoal): string {
  return [
    `Explain why this dependency exists.`,
    ``,
    `  ${goal.srcName}  --[${goal.edgeKind}]-->  ${goal.dstName}`,
    ``,
    `Find written evidence — a Slack thread, a PR, a commit message — that says why.`,
    `Quote the span verbatim and cite the permalink you retrieved it from.`,
    `If no written trace exists, call give_up. Do not guess.`,
  ].join("\n");
}

export function defaultLoopLimits() {
  return {
    stepBudget: config.HISTORIAN_STEP_BUDGET,
    maxParseFailures: config.HISTORIAN_MAX_PARSE_FAILURES,
  };
}
