import { connectorInstances, crawls, jobs } from "@sadhak/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import {
  allDescriptors,
  connectorConfigSchema,
  getConnector,
  isConnectorSlug,
  makeReadContext,
} from "../connectors/registry.js";
import { db } from "../db.js";
import { NotFoundError, UserError } from "../errors.js";
import { enqueue } from "../jobs/queue.js";
import { requireCapability } from "../middleware/auth.js";
import {
  getReadCredential,
  listCredentials,
  putCredential,
  vaultAvailable,
} from "../vault/vault.js";

export const connectorRoutes = new Hono();

/** Descriptors (with published scopes) plus this org's instances. Never credential material. */
connectorRoutes.get("/connectors", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const instances = await db
    .select()
    .from(connectorInstances)
    .where(eq(connectorInstances.orgId, orgId))
    .orderBy(connectorInstances.createdAt);

  return c.json({
    descriptors: allDescriptors(),
    vaultAvailable: vaultAvailable(),
    instances,
  });
});

connectorRoutes.post(
  "/connectors/:slug/instances",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const slug = c.req.param("slug");
    if (!isConnectorSlug(slug)) throw new UserError(`Unknown connector "${slug}"`);

    const body = z
      .object({
        displayName: z.string().min(1).max(120),
        config: z.record(z.unknown()).default({}),
        crawlFrequencyMinutes: z.number().int().min(5).max(1440).optional(),
      })
      .parse(await c.req.json());

    const config = connectorConfigSchema.parse(body.config);

    const [row] = await db
      .insert(connectorInstances)
      .values({
        orgId,
        connector: slug,
        displayName: body.displayName,
        config,
        ...(body.crawlFrequencyMinutes
          ? { crawlFrequencyMinutes: body.crawlFrequencyMinutes }
          : {}),
      })
      .returning();

    await audit(
      c,
      "connector.instance.created",
      {
        kind: "connector_instance",
        id: row?.id ?? 0,
      },
      { connector: slug },
    );

    return c.json(row, 201);
  },
);

connectorRoutes.patch(
  "/instances/:id",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const body = z
      .object({
        displayName: z.string().min(1).max(120).optional(),
        config: z.record(z.unknown()).optional(),
        crawlFrequencyMinutes: z.number().int().min(5).max(1440).optional(),
        disabled: z.boolean().optional(),
      })
      .parse(await c.req.json());

    const instance = await loadInstance(orgId, id);

    const [updated] = await db
      .update(connectorInstances)
      .set({
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.config ? { config: connectorConfigSchema.parse(body.config) } : {}),
        ...(body.crawlFrequencyMinutes
          ? { crawlFrequencyMinutes: body.crawlFrequencyMinutes }
          : {}),
        ...(body.disabled === undefined
          ? {}
          : {
              status: body.disabled
                ? ("disabled" as const)
                : instance.status === "disabled"
                  ? ("pending_auth" as const)
                  : instance.status,
            }),
        updatedAt: new Date(),
      })
      .where(eq(connectorInstances.id, id))
      .returning();

    await audit(c, "connector.instance.updated", { kind: "connector_instance", id });
    return c.json(updated);
  },
);

/**
 * Write-only by design: a credential goes in, and only its fingerprint comes
 * back. There is no read-back endpoint anywhere in the API.
 */
connectorRoutes.put(
  "/instances/:id/credential/:scope",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const scope = c.req.param("scope");
    if (scope !== "read" && scope !== "write") {
      throw new UserError('Credential scope must be "read" or "write"');
    }

    const instance = await loadInstance(orgId, id);
    const body = z
      .object({
        kind: z.string().min(1).max(40).default("api_key"),
        value: z.string().min(1),
      })
      .parse(await c.req.json());

    const actor = c.get("actor");
    const summary = await putCredential({
      orgId,
      instanceId: id,
      scope,
      kind: body.kind,
      value: body.value,
      createdBy: actor.type === "user" ? actor.id : null,
    });

    await audit(
      c,
      "credential.stored",
      { kind: "connector_credential", id: summary.id },
      {
        scope,
        credentialKind: body.kind,
        connector: instance.connector,
      },
    );

    // Storing a read credential moves the instance out of pending_auth.
    if (scope === "read") {
      await db
        .update(connectorInstances)
        .set({ status: "active", statusDetail: null, updatedAt: new Date() })
        .where(eq(connectorInstances.id, id));
    }

    return c.json(summary, 201);
  },
);

connectorRoutes.get(
  "/instances/:id/credentials",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    await loadInstance(orgId, id);
    return c.json({ items: await listCredentials(orgId, id) });
  },
);

/** Runs health() live and records what it found. */
connectorRoutes.post(
  "/instances/:id/test",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const instance = await loadInstance(orgId, id);

    const secret = await getReadCredential(orgId, id, "connector.test");
    if (!secret) {
      return c.json({ ok: false, detail: "No read credential stored yet" });
    }

    const connector = getConnector(instance.connector);
    const result = await connector.health(makeReadContext(orgId, instance, secret));

    await db
      .update(connectorInstances)
      .set({
        status: result.ok ? "active" : "error",
        statusDetail: result.detail ?? null,
        updatedAt: new Date(),
      })
      .where(eq(connectorInstances.id, id));

    await audit(
      c,
      "connector.instance.tested",
      { kind: "connector_instance", id },
      {
        ok: result.ok,
      },
    );

    return c.json(result);
  },
);

/** Crawl-now. Enqueues; the worker runs it. Deduped against an in-flight crawl. */
connectorRoutes.post(
  "/instances/:id/crawl",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    await loadInstance(orgId, id);

    const jobId = await enqueue(
      "connector.crawl",
      { instanceId: id, kind: "full" },
      { orgId, dedupeKey: `connector.crawl:${id}`, priority: 1 },
    );

    // Deduped means a crawl for this instance is already queued or running.
    // For an explicit "crawl now" the honest response is to pull the queued
    // one forward, not to silently do nothing.
    const pulledForward = jobId === null ? await runQueuedCrawlNow(id) : false;

    await audit(c, "connector.crawl_requested", { kind: "connector_instance", id });
    return c.json({ enqueued: jobId !== null || pulledForward, jobId }, 202);
  },
);

connectorRoutes.get(
  "/instances/:id/crawls",
  requireCapability("graph:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    await loadInstance(orgId, id);

    const rows = await db
      .select()
      .from(crawls)
      .where(and(eq(crawls.orgId, orgId), eq(crawls.connectorInstanceId, id)))
      .orderBy(desc(crawls.startedAt))
      .limit(20);

    return c.json({ items: rows });
  },
);

connectorRoutes.delete(
  "/instances/:id",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    await loadInstance(orgId, id);

    // Credentials cascade; graph nodes survive — reconciliation owns their fate.
    await db.delete(connectorInstances).where(eq(connectorInstances.id, id));
    await audit(c, "connector.instance.deleted", { kind: "connector_instance", id });
    return c.json({ ok: true });
  },
);

async function loadInstance(orgId: number, id: number) {
  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.orgId, orgId)))
    .limit(1);
  // Another org's instance is indistinguishable from one that does not exist.
  if (!instance) throw new NotFoundError();
  return instance;
}

/**
 * Pulls an already-queued crawl forward to now. Returns false when the crawl
 * is already running, in which case the caller's intent is satisfied anyway.
 */
async function runQueuedCrawlNow(instanceId: number): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set({ runAfter: new Date(), priority: 1 })
    .where(
      and(eq(jobs.dedupeKey, `connector.crawl:${instanceId}`), eq(jobs.state, "queued")),
    )
    .returning({ id: jobs.id });
  return updated.length > 0;
}
