import { reflexIncidents, reflexSettings } from "@sadhak/shared/schema";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { NotFoundError, UserError } from "../errors.js";
import { captureRationale } from "../historian/capture.js";
import { enqueue } from "../jobs/queue.js";
import { requireCapability } from "../middleware/auth.js";
import { claimForRevert, getIncident, markAcknowledged } from "../reflex/incidents.js";
import { isRevertible } from "../reflex/revert/index.js";

export const reflexRoutes = new Hono();

/** The incident feed — including silent APPROVEs, which still count. */
reflexRoutes.get("/incidents", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const rows = await db
    .select()
    .from(reflexIncidents)
    .where(eq(reflexIncidents.orgId, orgId))
    .orderBy(desc(reflexIncidents.createdAt))
    .limit(100);
  return c.json({ items: rows });
});

reflexRoutes.get("/incidents/:id", requireCapability("graph:read"), async (c) => {
  const incident = await getIncident(c.get("orgId"), Number(c.req.param("id")));
  if (!incident) throw new NotFoundError();
  return c.json(incident);
});

/**
 * Acknowledge: a human asserting "this change was fine". That assertion, with
 * its reason, is precisely the rationale the graph lacks — captured at the
 * moment the person still remembers why, and stored under our retention rather
 * than Slack's.
 *
 * The reason is optional with a strong nudge. A mandatory field produces
 * garbage rationale and tanks ack completion, which would poison the MTTR
 * numbers too.
 */
reflexRoutes.post(
  "/incidents/:id/acknowledge",
  requireCapability("graph:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const actor = c.get("actor");
    const actorLabel = actor.type === "user" ? actor.email : `api_key:${actor.id}`;

    const body = z
      .object({
        reason: z.string().max(4000).optional(),
        sourceUrl: z.string().url().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));

    const incident = await getIncident(orgId, id);
    if (!incident) throw new NotFoundError();

    let captured = false;
    const reason = body.reason?.trim();

    if (reason) {
      const edgeIds = [
        ...new Set(
          (incident.blast ?? []).flatMap((row) => row.path.map((hop) => hop.edgeId)),
        ),
      ];
      await captureRationale({
        orgId,
        // Each surface hands in its own permanent artifact. For a Reflex ack
        // that is the Slack thread reply; the incident page is the fallback
        // when the acknowledgment came through the web app.
        sourceUrl: body.sourceUrl ?? `https://sadhak.online/app/incidents/${id}`,
        text: reason,
        author: actorLabel,
        actor: actorLabel,
        edgeIds,
        incidentId: id,
      });
      captured = true;
    }

    await markAcknowledged(id, actorLabel, captured);
    await audit(
      c,
      "reflex.acknowledged",
      { kind: "reflex_incident", id },
      {
        rationaleCaptured: captured,
      },
    );

    return c.json({ ok: true, rationaleCaptured: captured });
  },
);

/** Writing to a customer system is the one thing that needs its own capability. */
reflexRoutes.post(
  "/incidents/:id/revert",
  requireCapability("reflex:revert"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    const actor = c.get("actor");
    const actorLabel = actor.type === "user" ? actor.email : `api_key:${actor.id}`;

    const incident = await getIncident(orgId, id);
    if (!incident) throw new NotFoundError();
    if (!isRevertible(incident.connector)) {
      throw new UserError(`No revert executor exists for ${incident.connector}`);
    }

    // A conditional claim means two clicks race safely.
    const claimed = await claimForRevert(id, actorLabel);
    if (!claimed) throw new UserError("This incident is already being reverted");

    await enqueue(
      "reflex.revert",
      { incidentId: id },
      { orgId, dedupeKey: `reflex.revert:${id}`, priority: 9, maxAttempts: 2 },
    );

    await audit(c, "reflex.revert_requested", { kind: "reflex_incident", id });
    return c.json({ ok: true, state: "reverting" }, 202);
  },
);

reflexRoutes.get("/reflex/settings", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const [row] = await db
    .select()
    .from(reflexSettings)
    .where(eq(reflexSettings.orgId, orgId))
    .limit(1);
  return c.json(
    row ?? { orgId, slackChannelId: null, alertThreshold: "WARN", dmActor: true },
  );
});

reflexRoutes.put("/reflex/settings", requireCapability("connector:manage"), async (c) => {
  const orgId = c.get("orgId");
  const body = z
    .object({
      slackChannelId: z.string().max(50).nullable().optional(),
      alertThreshold: z.enum(["APPROVE", "WARN", "BLOCK"]).optional(),
      dmActor: z.boolean().optional(),
    })
    .parse(await c.req.json());

  const [row] = await db
    .insert(reflexSettings)
    .values({
      orgId,
      slackChannelId: body.slackChannelId ?? null,
      ...(body.alertThreshold ? { alertThreshold: body.alertThreshold } : {}),
      ...(body.dmActor === undefined ? {} : { dmActor: body.dmActor }),
    })
    .onConflictDoUpdate({
      target: reflexSettings.orgId,
      set: {
        ...(body.slackChannelId === undefined
          ? {}
          : { slackChannelId: body.slackChannelId }),
        ...(body.alertThreshold ? { alertThreshold: body.alertThreshold } : {}),
        ...(body.dmActor === undefined ? {} : { dmActor: body.dmActor }),
      },
    })
    .returning();

  await audit(c, "reflex.settings_updated", { kind: "org", id: orgId });
  return c.json(row);
});
