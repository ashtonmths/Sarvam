import type { Capability } from "@sadhak/shared/rbac";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ForbiddenError, UserError } from "../errors.js";
import { log } from "../log.js";
import type { McpContext } from "./tools.js";

/**
 * One description of every tool, from which the wire format is generated.
 *
 * The previous arrangement kept two: zod schemas in `mcp/tools.ts` that the
 * handlers actually parsed with, and a hand-written JSON Schema literal in the
 * route that `tools/list` advertised. They had already drifted. `connector` was
 * `z.enum([...five slugs...])` in the parser and a bare `{ type: "string" }` on
 * the wire, so an agent had to guess the vocabulary and learned it existed only
 * by being rejected; `change` — the argument the whole gate turns on — was
 * published as `{ type: "object" }` with no properties at all, which tells a
 * caller precisely nothing about the one object it must get right.
 *
 * That drift is not a documentation problem. A tool schema is the entire
 * contract an agent has: it cannot read the source, so a field the schema omits
 * is a field that does not exist as far as the model is concerned, and a
 * constraint the schema omits is discovered by trying and failing. Generating
 * the published schema from the parsed schema means the failure mode is a
 * compile error rather than an agent looping against a validator.
 */

/**
 * The behavioural hints from the MCP spec, which are advisory to a client and
 * load-bearing to an agent's planner.
 *
 * `readOnlyHint` is the one that changes behaviour most: a client that knows a
 * tool cannot mutate anything may call it without confirmation, and a client
 * that does not know must either ask a human every time or stop asking at all.
 * Both of those are worse than telling it.
 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Whether the tool reaches a system outside this deployment's database. */
  openWorldHint: boolean;
}

export interface ToolOutcome<S = unknown> {
  /** Machine-readable, and the thing `outputSchema` describes. */
  structured: S;
  /** What the model actually reads. Prose, not serialised JSON. */
  text: string;
}

export interface ToolSpec<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  title: string;
  description: string;
  /** The capability a credential must hold. Enforced here, not at the caller. */
  scope: Capability;
  input: I;
  output: O;
  annotations: Omit<ToolAnnotations, "title">;
  run(ctx: McpContext, input: z.infer<I>): Promise<ToolOutcome<z.infer<O>>>;
}

export type AnyToolSpec = ToolSpec<z.ZodTypeAny, z.ZodTypeAny>;

/**
 * Checks a spec against its own generics, then widens it so specs with
 * different schemas can share an array.
 *
 * The cast is the price of a heterogeneous registry and it is confined to this
 * one line: at every call site `run` is still checked against the exact
 * `z.infer` of that tool's input, which is the property worth having.
 */
export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: ToolSpec<I, O>,
): AnyToolSpec {
  return spec as unknown as AnyToolSpec;
}

/**
 * Draft-07 with every `$ref` inlined.
 *
 * References are correct JSON Schema and a liability here. The consumer is a
 * language model reading a flattened tool list, and a `$ref` pointing into a
 * `definitions` block it may never have been shown is a hole in the contract
 * — models routinely fill such a hole with an invented shape. Inlining costs
 * some bytes and removes the guess.
 */
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const generated = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  // The dialect marker is meaningful to a validator and noise to a client that
  // only ever reads `properties` and `required`.
  const { $schema: _dialect, ...rest } = generated;
  return rest;
}

/** The tool as `tools/list` publishes it. */
export interface PublishedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export function publish(spec: AnyToolSpec): PublishedTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: jsonSchema(spec.input),
    outputSchema: jsonSchema(spec.output),
    annotations: { title: spec.title, ...spec.annotations },
  };
}

/**
 * Zod's own message, rewritten for the thing that has to act on it.
 *
 * A raw `ZodError` serialises to a nested object of codes and paths. An agent
 * handed that will usually retry with the same arguments, because nothing in it
 * says which field to change or what to change it to. Naming the path and the
 * expectation on one line each, and pointing at `tools/list` for the full
 * schema, is what turns a rejection into a correction.
 */
export function explainRejection(tool: string, error: z.ZodError): string {
  const shown = error.issues.slice(0, 8);
  const lines = shown.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(whole argument object)";
    return `  - ${path}: ${issue.message}`;
  });
  if (error.issues.length > shown.length) {
    lines.push(`  - …and ${error.issues.length - shown.length} more.`);
  }

  return [
    `${tool} rejected its arguments. Nothing ran and nothing changed.`,
    "",
    ...lines,
    "",
    "Fix the arguments named above and call it once more. Call tools/list if you need the exact schema; do not retry unchanged.",
  ].join("\n");
}

export interface Registry {
  /** Every tool, in a stable order. */
  all(): AnyToolSpec[];
  /** Only the tools this credential may actually call. */
  visibleTo(ctx: McpContext): AnyToolSpec[];
  get(name: string): AnyToolSpec | undefined;
  call(name: string, args: unknown, ctx: McpContext): Promise<ToolOutcome>;
}

export function createRegistry(specs: AnyToolSpec[]): Registry {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  if (byName.size !== specs.length) {
    // A duplicate name silently shadows a tool, and the shadowed one is
    // unreachable in a way nothing else would ever report.
    throw new Error("Two MCP tools share a name");
  }

  const visibleTo = (ctx: McpContext) =>
    specs.filter((spec) => ctx.scopes.includes(spec.scope));

  return {
    all: () => [...specs],
    visibleTo,
    get: (name) => byName.get(name),

    async call(name, args, ctx) {
      const spec = byName.get(name);
      if (!spec) {
        /**
         * The reachable names, not all of them. A key without
         * `connector:manage` that is told `ingest_document` exists will keep
         * trying it; listing what this credential can actually reach turns a
         * dead end into a next step.
         */
        const reachable = visibleTo(ctx)
          .map((s) => s.name)
          .join(", ");
        throw new UserError(
          `No tool named "${name}". This credential can call: ${reachable || "(none — the credential holds no capability this server exposes)"}.`,
          { status: 404, type: "unknown-tool" },
        );
      }

      if (!ctx.scopes.includes(spec.scope)) {
        throw new ForbiddenError(
          `${spec.name} needs the "${spec.scope}" capability and this credential does not hold it. Nothing ran. Ask an administrator to mint a key with that capability rather than retrying.`,
        );
      }

      const parsed = spec.input.safeParse(args);
      if (!parsed.success) {
        throw new UserError(explainRejection(spec.name, parsed.error), {
          status: 422,
          type: "tool-arguments",
        });
      }

      const outcome = await spec.run(ctx, parsed.data);

      /**
       * Declaring `outputSchema` obliges this server to return
       * `structuredContent` that matches it, so the claim is checked rather
       * than asserted.
       *
       * A mismatch warns and still returns the payload. Refusing to answer
       * would convert a cosmetic schema slip — a nullable field that came back
       * absent — into a hard tool failure for a caller who mostly wants the
       * prose, which is a strictly worse trade. The contract tests assert this
       * warning never fires, so the loose runtime behaviour does not become the
       * way drift survives.
       */
      const checked = spec.output.safeParse(outcome.structured);
      if (!checked.success) {
        log().warn(
          { tool: spec.name, issues: checked.error.issues.slice(0, 5) },
          "MCP tool output did not match its declared outputSchema",
        );
      }

      return outcome;
    },
  };
}
