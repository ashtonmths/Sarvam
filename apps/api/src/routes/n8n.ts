import { n8nAccounts, n8nExecutionFailures } from "@sadhak/shared/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { seedDemoData } from "../demo/data.js";
import { NotFoundError } from "../errors.js";
import { enqueue } from "../jobs/queue.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import {
  createDemoWorkflows,
  SCENARIOS,
  type ScenarioKey,
  simulateWorkflowFailure,
} from "../n8n/demo.js";
import { getCredential } from "../vault/vault.js";

export const n8nRoutes = new Hono();

const failureQuery = z.object({
  /** Narrow to one workflow — the common case when triaging a flapping flow. */
  workflowId: z.string().optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The failure feed for this org.
 *
 * Org-scoped by `c.get("orgId")` and never by anything in the query string:
 * an execution failure names a workflow the caller may not own, and letting a
 * client pass its own org id is how that becomes a cross-tenant read.
 */
n8nRoutes.get("/n8n/failures", requireCapability("graph:read"), async (c) => {
  const query = failureQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const orgId = c.get("orgId");

  const filters = [eq(n8nExecutionFailures.orgId, orgId)];
  if (query.workflowId) {
    filters.push(eq(n8nExecutionFailures.workflowId, query.workflowId));
  }
  if (query.since) {
    filters.push(gte(n8nExecutionFailures.detectedAt, query.since));
  }

  const items = await db
    .select()
    .from(n8nExecutionFailures)
    .where(and(...filters))
    .orderBy(desc(n8nExecutionFailures.detectedAt))
    .limit(query.limit);

  return c.json({ items });
});

/**
 * The caller's own n8n account.
 *
 * Keyed on the session's user id rather than a path parameter, because the
 * response carries `inviteAcceptUrl` — a single-use link that sets a password
 * on that account. Anyone who can read another user's row can take over their
 * n8n, so there is deliberately no route that accepts a user id at all.
 */
/**
 * One failure and everything behind its diagnosis.
 *
 * What the Slack alert's button opens. The alert is short on purpose, so this
 * has to carry the evidence: the impact, the windows searched, the error, and
 * what the model concluded. A recommendation nobody can check is one nobody
 * should act on.
 */
n8nRoutes.get("/n8n/failures/:id", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new NotFoundError();

  const [row] = await db
    .select()
    .from(n8nExecutionFailures)
    // Scoped by org as well as by id. A failure id is a small integer, and
    // guessing another tenant's must find nothing rather than something.
    .where(and(eq(n8nExecutionFailures.id, id), eq(n8nExecutionFailures.orgId, orgId)))
    .limit(1);

  if (!row) throw new NotFoundError();
  return c.json({ failure: row });
});

/**
 * Create the demo workflows, and break one on purpose.
 *
 * Buttons rather than scripts, because a hosted deployment has no terminal and
 * "ssh in and run this" is not a demo anyone can give. `connector:manage`
 * rather than a read capability: both write to the org's own n8n.
 */
n8nRoutes.post("/n8n/demo/workflows", requireCapability("connector:manage"), async (c) =>
  c.json(await createDemoWorkflows(c.get("orgId"))),
);

/**
 * Writes the demo dataset — transcripts, commit history, checkpoints, rationale,
 * metrics, an incident — into this organisation.
 *
 * Beside the other demo endpoints because it is the same act: making a fresh
 * deployment worth looking at, from a UI with no terminal behind it.
 */
n8nRoutes.post("/n8n/demo/data", requireCapability("connector:manage"), async (c) =>
  c.json(await seedDemoData(c.get("orgId"))),
);

/**
 * Break one on purpose. The scenario decides which branch of the diagnosis it
 * lands in, which is the part worth being able to show on demand.
 */
n8nRoutes.post("/n8n/demo/simulate", requireCapability("connector:manage"), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { scenario?: string };
  const scenario =
    body.scenario && body.scenario in SCENARIOS
      ? (body.scenario as ScenarioKey)
      : "schema";
  return c.json(await simulateWorkflowFailure(c.get("orgId"), scenario));
});

/** What the buttons render themselves from, so the two cannot drift. */
n8nRoutes.get("/n8n/demo/scenarios", requireCapability("graph:read"), async (c) =>
  c.json({
    scenarios: Object.entries(SCENARIOS).map(([key, v]) => ({
      key,
      label: v.label,
      blurb: v.blurb,
      expect: v.expect,
    })),
  }),
);

n8nRoutes.get("/n8n/account", requireAuth, async (c) => {
  const actor = c.get("actor");
  if (actor.type !== "user") return c.json({ account: null });

  const [account] = await db
    .select({
      state: n8nAccounts.state,
      email: n8nAccounts.email,
      inviteAcceptUrl: n8nAccounts.inviteAcceptUrl,
      instanceId: n8nAccounts.instanceId,
      failureReason: n8nAccounts.failureReason,
      createdAt: n8nAccounts.createdAt,
      invitedAt: n8nAccounts.invitedAt,
      activatedAt: n8nAccounts.activatedAt,
    })
    .from(n8nAccounts)
    .where(eq(n8nAccounts.userId, actor.id))
    .limit(1);

  /**
   * Checking on an invite is the moment to find out whether it was accepted.
   *
   * n8n never announces acceptance, so somebody has to look, and this is the
   * only point where a user has expressed interest in the answer. Enqueued
   * rather than awaited: the upstream call belongs nowhere near the latency of
   * a GET, and the reconciled state is what the next read returns.
   */
  if (account?.state === "invited") {
    await enqueue(
      "n8n.refresh_account",
      { userId: actor.id },
      { orgId: c.get("orgId"), dedupeKey: `n8n.refresh_account:${actor.id}` },
    ).catch(() => undefined);
  }

  // Sent alongside the account rather than baked into the web bundle: the
  // address differs per deployment, and NEXT_PUBLIC_ values are fixed at image
  // build time, so one image could not serve both local and production.
  return c.json({ account: account ?? null, n8nUrl: config.N8N_PUBLIC_URL ?? null });
});

/**
 * Reveals the n8n password Sadhak generated for the caller.
 *
 * A deliberate request, not a field on the account response, for two reasons.
 * The connectors page polls that endpoint, and a password that rides along on
 * every render is a password in far more logs, caches and screenshots than it
 * needs to be. And a reveal is worth auditing — this is the one moment a
 * secret leaves the vault for a human, so it should be as visible in the audit
 * trail as storing it was.
 *
 * Only the account's own user can ask. There is no user id in the path, for
 * the same reason the invite link had none.
 */
n8nRoutes.post("/n8n/account/reveal", requireAuth, async (c) => {
  const actor = c.get("actor");
  if (actor.type !== "user") throw new NotFoundError();

  const [account] = await db
    .select({ email: n8nAccounts.email, instanceId: n8nAccounts.instanceId })
    .from(n8nAccounts)
    .where(eq(n8nAccounts.userId, actor.id))
    .limit(1);

  if (!account?.instanceId) throw new NotFoundError();

  const secret = await getCredential(
    c.get("orgId"),
    account.instanceId,
    "read",
    "n8n_user_password",
    "n8n.account.reveal",
  );

  // No password stored means the user set their own — nothing to reveal, and
  // saying so is better than an empty string that reads like a bug.
  if (!secret) {
    return c.json({ email: account.email, password: null, reason: "user_set" });
  }

  await audit(c, "n8n.password_revealed", { kind: "user", id: actor.id });

  return c.json({ email: account.email, password: secret.reveal(), reason: null });
});
