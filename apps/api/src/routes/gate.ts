import { gateDecisions, verdicts } from "@sadhak/shared/schema";
import { changeDescriptorSchema } from "@sadhak/shared/types";
import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { ForbiddenError, NotFoundError, UserError } from "../errors.js";
import { assertNotBothModes, executeChange } from "../forward/execute.js";
import { decide } from "../gate/decide.js";
import { paginated, parsePagination } from "../http/pagination.js";
import { requireCapability } from "../middleware/auth.js";

export const gateRoutes = new Hono();

const gateBodySchema = z.object({
  change: changeDescriptorSchema,
  dry_run: z.boolean().default(false),
  /** Execute-on-approve. Requires `gate:execute`, granted separately. */
  execute: z.boolean().default(false),
});

/**
 * Mode 2, the proxy gate. What scripts and admin tools call, and what the MCP
 * server wraps — the same `decide()` behind both, so REST and MCP cannot drift.
 */
gateRoutes.post("/gate", requireCapability("gate:invoke"), async (c) => {
  const orgId = c.get("orgId");
  const actor = c.get("actor");
  const body = gateBodySchema.parse(await c.req.json());
  const idempotencyKey = c.req.header("Idempotency-Key");
  assertNotBothModes(body.dry_run, body.execute);

  const outcome = await decide(body.change, {
    orgId,
    mode: actor.type === "api_key" ? "proxy_gate" : "proxy_gate",
    dryRun: body.dry_run,
    actor:
      body.change.actor ?? (actor.type === "user" ? actor.email : `api_key:${actor.id}`),
    apiKeyId: actor.type === "api_key" ? actor.id : null,
    idempotencyKey,
  });

  await audit(
    c,
    "gate.decision",
    { kind: "gate_decision", id: outcome.decisionId },
    {
      verdict: outcome.result.verdict,
      dryRun: body.dry_run,
      replayed: outcome.replayed,
    },
  );

  if (outcome.replayed) c.header("Idempotency-Replayed", "true");

  // Forwarding: Sadhak evaluates, and only Sadhak executes, under the
  // separately-granted write credential. A BLOCK performs zero connector calls.
  let execution: Awaited<ReturnType<typeof executeChange>> | null = null;
  if (body.execute && !outcome.replayed) {
    if (actor.type === "api_key" && !actor.scopes.includes("reflex:revert")) {
      throw new ForbiddenError(
        'Executing a change needs a write capability — "gate:invoke" alone cannot execute',
      );
    }
    execution = await executeChange(
      orgId,
      body.change,
      outcome.result,
      outcome.decisionId,
    );
    await audit(
      c,
      "gate.executed",
      { kind: "gate_decision", id: outcome.decisionId },
      {
        executed: execution.executed,
      },
    );
  }

  return c.json({
    decision_id: outcome.decisionId,
    verdict_id: outcome.verdictId,
    verdict: outcome.result.verdict,
    evidence: outcome.result.evidence,
    impacted: outcome.result.impacted,
    computed_in_ms: outcome.result.computedInMs,
    graph_version: outcome.result.graphVersion,
    dry_run: body.dry_run,
    replayed: outcome.replayed,
    ...(execution
      ? {
          executed: execution.executed,
          execution_detail: execution.executed ? execution.detail : execution.error,
        }
      : { executed: false }),
  });
});

/** The decision log. Plan 12's `/app/decisions` screen is a table over this. */
gateRoutes.get("/gate/decisions", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const { limit, cursor } = parsePagination(c.req.query());

  const mode = c.req.query("mode");
  const verdictFilter = c.req.query("verdict");
  const dryRun = c.req.query("dry_run");
  const actorFilter = c.req.query("actor");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const filters = [eq(gateDecisions.orgId, orgId)];
  if (mode) filters.push(eq(gateDecisions.mode, mode as "proxy_gate"));
  if (verdictFilter) filters.push(eq(verdicts.verdict, verdictFilter));
  if (dryRun === "true") filters.push(eq(gateDecisions.dryRun, true));
  if (dryRun === "false") filters.push(eq(gateDecisions.dryRun, false));
  if (actorFilter) filters.push(eq(gateDecisions.actor, actorFilter));
  if (from) filters.push(gte(gateDecisions.createdAt, new Date(from)));
  if (to) filters.push(lte(gateDecisions.createdAt, new Date(to)));
  if (cursor) {
    const at = new Date(cursor.k);
    filters.push(
      or(
        lt(gateDecisions.createdAt, at),
        and(eq(gateDecisions.createdAt, at), lt(gateDecisions.id, cursor.i)),
      )!,
    );
  }

  // Summary fields only; the full evidence snapshot is fetched per row.
  const rows = await db
    .select({
      id: gateDecisions.id,
      verdictId: gateDecisions.verdictId,
      mode: gateDecisions.mode,
      dryRun: gateDecisions.dryRun,
      actor: gateDecisions.actor,
      createdAt: gateDecisions.createdAt,
      verdict: verdicts.verdict,
      computedInMs: verdicts.computedInMs,
      change: verdicts.change,
    })
    .from(gateDecisions)
    .innerJoin(verdicts, eq(verdicts.id, gateDecisions.verdictId))
    .where(and(...filters))
    .orderBy(desc(gateDecisions.createdAt), desc(gateDecisions.id))
    .limit(limit + 1);

  return c.json(
    paginated(rows, limit, (row) => ({ k: row.createdAt.toISOString(), i: row.id })),
  );
});

/** The "why did you block my change?" answer page. */
gateRoutes.get("/gate/decisions/:id", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new UserError("decision id must be an integer");

  const [row] = await db
    .select({
      id: gateDecisions.id,
      verdictId: gateDecisions.verdictId,
      mode: gateDecisions.mode,
      dryRun: gateDecisions.dryRun,
      actor: gateDecisions.actor,
      executedAt: gateDecisions.executedAt,
      executionResult: gateDecisions.executionResult,
      createdAt: gateDecisions.createdAt,
      verdict: verdicts.verdict,
      change: verdicts.change,
      impacted: verdicts.impacted,
      evidence: verdicts.evidence,
      computedInMs: verdicts.computedInMs,
      graphVersion: verdicts.graphVersion,
      explanation: verdicts.explanation,
      explanationState: verdicts.explanationState,
    })
    .from(gateDecisions)
    .innerJoin(verdicts, eq(verdicts.id, gateDecisions.verdictId))
    .where(and(eq(gateDecisions.id, id), eq(gateDecisions.orgId, orgId)))
    .limit(1);

  if (!row) throw new NotFoundError();
  return c.json(row);
});
