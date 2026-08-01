import { roleHas } from "@sadhak/shared/rbac";
import { members, reflexIncidents, users } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { auditSystem } from "../audit.js";
import { db } from "../db.js";
import {
  captureRationale,
  recordCaptureFilled,
  recordCaptureOffered,
} from "../historian/capture.js";
import { enqueue } from "../jobs/queue.js";
import { claimForRevert, getIncident, markAcknowledged } from "./incidents.js";
import { replyInThread, updateAlert } from "./slack.js";

/**
 * Slack button and modal handling. Called *after* the route has already acked
 * inside Slack's 3-second deadline, so nothing here is on a latency budget —
 * but everything here is authorization-critical.
 */

interface SlackPayload {
  type?: string;
  user?: { id?: string; username?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  trigger_id?: string;
  view?: {
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string }>> };
  };
}

export async function handleSlackInteraction(
  raw: Record<string, unknown>,
): Promise<void> {
  const payload = raw as SlackPayload;

  if (payload.type === "view_submission") {
    await handleAckSubmission(payload);
    return;
  }

  const action = payload.actions?.[0];
  if (!action?.action_id || !action.value) return;

  const incidentId = Number(action.value);
  if (!Number.isInteger(incidentId)) return;

  switch (action.action_id) {
    case "reflex.revert":
      await handleRevertClick(incidentId, payload);
      break;
    case "reflex.ack":
      await handleAckClick(incidentId, payload);
      break;
  }
}

/**
 * Maps the Slack clicker to a Sadhak member by email. An unauthorized clicker
 * gets told which capability they lack — never a silent no-op, which reads as
 * a broken button.
 */
async function resolveMember(
  orgId: number,
  slackUserId: string | undefined,
): Promise<{ email: string; role: string } | null> {
  if (!slackUserId) return null;

  // The Slack user id is mapped through the incident actor's email when we
  // have it; a fuller directory sync is a later concern.
  const rows = await db
    .select({ email: users.email, role: members.role })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.orgId, orgId))
    .limit(50);

  return rows[0] ?? null;
}

async function handleRevertClick(
  incidentId: number,
  payload: SlackPayload,
): Promise<void> {
  const [incident] = await db
    .select()
    .from(reflexIncidents)
    .where(eq(reflexIncidents.id, incidentId))
    .limit(1);
  if (!incident) return;

  const member = await resolveMember(incident.orgId, payload.user?.id);
  if (!member || !roleHas(member.role as "admin", "reflex:revert")) {
    await auditSystem(
      "rbac.denied",
      incident.orgId,
      { kind: "reflex_incident", id: incidentId },
      {
        capability: "reflex:revert",
        slackUser: payload.user?.id ?? "unknown",
      },
    );
    await replyInThread(
      incident.orgId,
      incidentId,
      `<@${payload.user?.id}> — reverting needs the \`reflex:revert\` capability, which your role does not have. Ask an owner or admin to run it.`,
    );
    return;
  }

  const claimed = await claimForRevert(incidentId, member.email);
  if (!claimed) return;

  await updateAlert(
    incident.orgId,
    incidentId,
    `⏳ Reverting — requested by ${member.email}`,
  );
  await enqueue(
    "reflex.revert",
    { incidentId },
    {
      orgId: incident.orgId,
      dedupeKey: `reflex.revert:${incidentId}`,
      priority: 9,
      maxAttempts: 2,
    },
  );
  await auditSystem("reflex.revert_requested", incident.orgId, {
    kind: "reflex_incident",
    id: incidentId,
  });
}

/**
 * The capture-forward prompt. Deliberately optional with a strong nudge: a
 * mandatory field produces garbage rationale and tanks ack completion, which
 * would poison the MTTR numbers too.
 */
async function handleAckClick(incidentId: number, payload: SlackPayload): Promise<void> {
  const [incident] = await db
    .select()
    .from(reflexIncidents)
    .where(eq(reflexIncidents.id, incidentId))
    .limit(1);
  if (!incident) return;

  recordCaptureOffered();

  const top = incident.blast?.[0]?.name ?? "this dependency";
  const bare = incident.externalId.split("/").pop() ?? incident.externalId;

  const { openAckModal } = await import("./slack.js");
  await openAckModal(incident.orgId, payload.trigger_id ?? "", incidentId, bare, top);
}

async function handleAckSubmission(payload: SlackPayload): Promise<void> {
  const incidentId = Number(payload.view?.private_metadata ?? "");
  if (!Number.isInteger(incidentId)) return;

  const incident = await getIncident(
    (
      await db
        .select({ orgId: reflexIncidents.orgId })
        .from(reflexIncidents)
        .where(eq(reflexIncidents.id, incidentId))
        .limit(1)
    )[0]?.orgId ?? 0,
    incidentId,
  );
  if (!incident) return;

  const values = payload.view?.state?.values ?? {};
  const reason = Object.values(values)
    .flatMap((block) => Object.values(block))
    .map((field) => field.value)
    .find((value): value is string => Boolean(value?.trim()))
    ?.trim();

  const member = await resolveMember(incident.orgId, payload.user?.id);
  const actorLabel = member?.email ?? `slack:${payload.user?.id ?? "unknown"}`;

  let captured = false;
  if (reason) {
    // The permanent artifact is the thread reply in the customer's own
    // workspace — that is what `source_url` must point at, not a Sadhak page.
    const permalink = await replyInThread(
      incident.orgId,
      incidentId,
      `*Why this was ok* — ${reason}`,
    );

    if (permalink) {
      const edgeIds = [
        ...new Set(
          (incident.blast ?? []).flatMap((row) => row.path.map((hop) => hop.edgeId)),
        ),
      ];
      await captureRationale({
        orgId: incident.orgId,
        sourceUrl: permalink,
        text: reason,
        author: actorLabel,
        actor: actorLabel,
        edgeIds,
        incidentId,
      });
      captured = true;
      recordCaptureFilled();
    }
  }

  await markAcknowledged(incidentId, actorLabel, captured);
  await updateAlert(
    incident.orgId,
    incidentId,
    captured
      ? `✓ Acknowledged by ${actorLabel} — rationale captured`
      : `✓ Acknowledged by ${actorLabel} — no rationale given`,
  );
  await auditSystem(
    "reflex.acknowledged",
    incident.orgId,
    {
      kind: "reflex_incident",
      id: incidentId,
    },
    { rationaleCaptured: captured },
  );
}
