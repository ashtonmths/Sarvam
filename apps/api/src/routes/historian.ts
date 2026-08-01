import {
  agentTraces,
  historianRunEdges,
  historianRuns,
  miningScopes,
  nodes,
} from "@sadhak/shared/schema";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { NotFoundError, RateLimitedError, UserError } from "../errors.js";
import { requestsRemainingToday } from "../historian/budget.js";
import { createRun, edgesOnlyExplainedBy, preflight } from "../historian/runs.js";
import { enqueue } from "../jobs/queue.js";
import { requireCapability } from "../middleware/auth.js";

export const historianRoutes = new Hono();

const createRunSchema = z.union([
  z.object({ kind: z.literal("edge"), edgeId: z.number().int() }),
  z.object({ kind: z.literal("exit_interview"), subjectNodeId: z.number().int() }),
]);

historianRoutes.post("/historian/runs", requireCapability("gate:invoke"), async (c) => {
  const orgId = c.get("orgId");
  const actor = c.get("actor");
  const body = createRunSchema.parse(await c.req.json());
  const startedBy = actor.type === "user" ? actor.email : `api_key:${actor.id}`;

  let edgeIds: number[];
  let subjectNodeId: number | null = null;

  if (body.kind === "edge") {
    edgeIds = [body.edgeId];
  } else {
    const [person] = await db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(and(eq(nodes.id, body.subjectNodeId), eq(nodes.orgId, orgId)))
      .limit(1);
    if (!person) throw new NotFoundError();
    subjectNodeId = person.id;
    edgeIds = await edgesOnlyExplainedBy(orgId, person.id, person.name);
  }

  if (edgeIds.length === 0) {
    return c.json(
      { edges: 0, message: "Nothing to investigate — no sole-source edges." },
      200,
    );
  }

  // Refuse before any row is written: a refused run leaves nothing behind.
  const check = await preflight(edgeIds.length);
  if (!check.fits) {
    const error = new RateLimitedError(
      `${edgeIds.length} edges need ~${check.estimated} model requests; ${check.remaining} remain today. Investigate the ${check.edgesThatWouldFit} highest-criticality now, or start the rest after the cap resets.`,
    );
    c.header("Retry-After", "3600");
    return c.json(
      {
        type: "https://sadhak.online/errors/rate-limited",
        title: "Not enough model quota remains today",
        status: 429,
        detail: error.message,
        remaining: check.remaining,
        estimated: check.estimated,
        edgesThatWouldFit: check.edgesThatWouldFit,
      },
      429,
    );
  }

  const runId = await createRun({
    orgId,
    kind: body.kind,
    edgeIds,
    subjectNodeId,
    startedBy,
  });

  await enqueue(
    "historian.run",
    { runId },
    { orgId, dedupeKey: `historian.run:${runId}`, priority: -1 },
  );

  await audit(
    c,
    "historian.run_started",
    { kind: "historian_run", id: runId },
    {
      edges: edgeIds.length,
      estimated: check.estimated,
    },
  );

  return c.json(
    { runId, edges: edgeIds.length, estimatedRequests: check.estimated },
    202,
  );
});

historianRoutes.get("/historian/runs", requireCapability("graph:read"), async (c) => {
  const rows = await db
    .select()
    .from(historianRuns)
    .where(eq(historianRuns.orgId, c.get("orgId")))
    .orderBy(desc(historianRuns.createdAt))
    .limit(50);
  return c.json({ items: rows });
});

historianRoutes.get("/historian/runs/:id", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const [run] = await db
    .select()
    .from(historianRuns)
    .where(and(eq(historianRuns.id, c.req.param("id")), eq(historianRuns.orgId, orgId)))
    .limit(1);
  if (!run) throw new NotFoundError();

  const edges = await db
    .select()
    .from(historianRunEdges)
    .where(eq(historianRunEdges.runId, run.id));

  return c.json({ run, edges });
});

historianRoutes.post(
  "/historian/runs/:id/cancel",
  requireCapability("gate:invoke"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    const updated = await db
      .update(historianRuns)
      .set({ state: "cancelled", finishedAt: new Date() })
      .where(and(eq(historianRuns.id, id), eq(historianRuns.orgId, orgId)))
      .returning({ id: historianRuns.id });
    if (updated.length === 0) throw new NotFoundError();

    await audit(c, "historian.run_cancelled", { kind: "historian_run", id });
    return c.json({ ok: true });
  },
);

/**
 * Live traces, or a replay of a finished run. One code path, one event shape.
 * A run costs its model requests once and nothing every time after — which is
 * what makes a repeat demo free.
 */
historianRoutes.get(
  "/historian/runs/:id/events",
  requireCapability("graph:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const runId = c.req.param("id");
    const replay = c.req.query("replay") === "1";

    const [run] = await db
      .select()
      .from(historianRuns)
      .where(and(eq(historianRuns.id, runId), eq(historianRuns.orgId, orgId)))
      .limit(1);
    if (!run) throw new NotFoundError();

    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      let cursor = Number(c.req.header("Last-Event-ID") ?? 0);
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });

      const loopIds = async () => {
        const rows = await db
          .select({ loopRunId: historianRunEdges.loopRunId })
          .from(historianRunEdges)
          .where(eq(historianRunEdges.runId, runId));
        return rows.map((r) => r.loopRunId).filter((v): v is string => v !== null);
      };

      for (let tick = 0; !aborted && tick < 1200; tick += 1) {
        const ids = await loopIds();

        if (ids.length > 0) {
          const traces = await db
            .select()
            .from(agentTraces)
            .where(and(eq(agentTraces.orgId, orgId), gt(agentTraces.id, cursor)))
            .orderBy(asc(agentTraces.id))
            .limit(100);

          for (const row of traces) {
            if (!ids.includes(row.runId)) continue;
            cursor = row.id;
            await stream.writeSSE({
              id: String(row.id),
              event: "trace",
              data: JSON.stringify({
                loopRunId: row.runId,
                step: row.step,
                tool: row.tool,
                input: row.input,
                output: row.output,
              }),
            });
            // Replay is paced by the recorded cadence, clamped so a demo never
            // stalls on one slow tool call.
            if (replay) await stream.sleep(Math.min(600, 200));
          }
        }

        const [current] = await db
          .select()
          .from(historianRuns)
          .where(eq(historianRuns.id, runId))
          .limit(1);

        if (!current) break;

        if (current.state === "done" || current.state === "cancelled") {
          await stream.writeSSE({
            event: "run",
            data: JSON.stringify({
              state: current.state,
              edgesTotal: current.edgesTotal,
              edgesProposed: current.edgesProposed,
              edgesGaveUp: current.edgesGaveUp,
              edgesSkippedQuota: current.edgesSkippedQuota,
              requestsUsed: current.requestsUsed,
            }),
          });
          break;
        }

        if (replay) break;
        // A comment heartbeat keeps proxies from reaping an idle connection.
        if (tick % 30 === 29) await stream.writeSSE({ event: "ping", data: "{}" });
        await stream.sleep(500);
      }
    });
  },
);

/* ------------------------------------------------------------- scopes */

historianRoutes.get("/mining-scopes", requireCapability("graph:read"), async (c) => {
  const rows = await db
    .select()
    .from(miningScopes)
    .where(eq(miningScopes.orgId, c.get("orgId")));
  return c.json({ items: rows });
});

historianRoutes.post(
  "/mining-scopes",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const body = z
      .object({
        connector: z.enum(["slack", "github"]),
        scopeValue: z.string().min(1).max(200),
      })
      .parse(await c.req.json());
    const actor = c.get("actor");

    const [row] = await db
      .insert(miningScopes)
      .values({
        orgId,
        connector: body.connector,
        scopeValue: body.scopeValue,
        addedBy: actor.type === "user" ? actor.email : `api_key:${actor.id}`,
      })
      .onConflictDoNothing()
      .returning();

    await audit(
      c,
      "mining_scope.added",
      { kind: "mining_scope", id: row?.id ?? 0 },
      {
        connector: body.connector,
        scopeValue: body.scopeValue,
      },
    );
    return c.json(row ?? { ok: true }, 201);
  },
);

historianRoutes.delete(
  "/mining-scopes/:id",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const deleted = await db
      .delete(miningScopes)
      .where(and(eq(miningScopes.id, id), eq(miningScopes.orgId, orgId)))
      .returning({ id: miningScopes.id });
    if (deleted.length === 0) throw new NotFoundError();
    await audit(c, "mining_scope.removed", { kind: "mining_scope", id });
    return c.json({ ok: true });
  },
);

/** What an operator needs to know before starting a fan-out today. */
historianRoutes.get("/historian/quota", requireCapability("graph:read"), async (c) => {
  const remaining = await requestsRemainingToday();
  return c.json({
    remaining,
    note: "Account-wide, shared across every org. Free-tier models cap at 20 requests/minute and 1000/day after the one-time credit.",
  });
});

export function assertRunnable(edgeIds: number[]): void {
  if (edgeIds.length === 0) throw new UserError("No edges to investigate");
}
