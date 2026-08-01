import {
  connectorInstances,
  rationale,
  rationaleLinks,
  reflexIncidents,
  reflexSettings,
} from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { getCredential } from "../vault/vault.js";
import { buildAlert, buildEscalation, type RationaleLink } from "./alert.js";
import { getIncident, markAlerted } from "./incidents.js";
import { isRevertible } from "./revert/index.js";

/**
 * The only module that talks to Slack — mirrors the `llm.ts` isolation rule,
 * for the same reason: swapping or disabling the vendor touches one file.
 *
 * Slack being unreachable is a degradation, never a failure of Reflex: the
 * incident row and every timestamp are complete either way, and the web
 * incident feed remains the fallback surface.
 */

const SLACK_API = "https://slack.com/api";

async function botToken(orgId: number): Promise<string | null> {
  const [instance] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.orgId, orgId), eq(connectorInstances.connector, "slack")),
    )
    .limit(1);
  if (!instance) return null;

  const secret = await getCredential(
    orgId,
    instance.id,
    "read",
    "oauth_access",
    "reflex.slack",
  );
  return secret?.reveal() ?? null;
}

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { ok?: boolean } & Record<string, unknown>;
  return payload.ok ? (payload as T) : null;
}

async function rationaleForBlast(
  orgId: number,
  edgeIds: number[],
): Promise<RationaleLink[]> {
  if (edgeIds.length === 0) return [];
  const rows = await db
    .select({
      body: rationale.body,
      sourceUrl: rationale.sourceUrl,
      author: rationale.author,
      state: rationale.state,
    })
    .from(rationale)
    .innerJoin(rationaleLinks, eq(rationaleLinks.rationaleId, rationale.id))
    .where(and(eq(rationale.orgId, orgId), eq(rationale.state, "confirmed")))
    .limit(3);
  return rows;
}

/**
 * One message per incident, keyed by `slack_ts`. Everything afterwards —
 * explainer prose, revert progress, escalation — is an update or a threaded
 * reply, never a repost.
 */
export async function postIncidentAlert(
  orgId: number,
  incidentId: number,
): Promise<boolean> {
  const incident = await getIncident(orgId, incidentId);
  if (!incident || incident.slackTs) return false;

  const [settings] = await db
    .select()
    .from(reflexSettings)
    .where(eq(reflexSettings.orgId, orgId))
    .limit(1);

  const channel = settings?.slackChannelId;
  if (!channel) return false;

  const token = await botToken(orgId);
  if (!token) return false;

  const blast = incident.blast ?? [];
  const edgeIds = [...new Set(blast.flatMap((row) => row.path.map((hop) => hop.edgeId)))];

  const { text, blocks } = buildAlert({
    incident,
    blast,
    rationale: await rationaleForBlast(orgId, edgeIds),
    revertAvailable:
      isRevertible(incident.connector) &&
      (await hasWriteGrant(orgId, incident.connector)),
    incidentUrl: `https://sadhak.online/app/incidents/${incident.id}`,
  });

  const posted = await call<{ ts?: string }>(token, "chat.postMessage", {
    channel,
    text,
    blocks,
  });
  if (!posted?.ts) return false;

  await markAlerted(incidentId, channel, posted.ts);

  // The DM is a pointer to the shared message, so two people never act on two
  // copies. Neutral wording — "detected", never "you broke".
  if (settings?.dmActor && incident.actor?.email) {
    const user = await call<{ user?: { id?: string } }>(token, "users.lookupByEmail", {
      email: incident.actor.email,
    });
    const userId = user?.user?.id;
    if (userId) {
      await call(token, "chat.postMessage", {
        channel: userId,
        text: `Sadhak detected a change you made. The team alert is in <#${channel}>.`,
      });
    }
  }

  return true;
}

export async function updateAlert(
  orgId: number,
  incidentId: number,
  text: string,
): Promise<void> {
  const incident = await getIncident(orgId, incidentId);
  if (!incident?.slackTs || !incident.slackChannel) return;

  const token = await botToken(orgId);
  if (!token) return;

  await call(token, "chat.update", {
    channel: incident.slackChannel,
    ts: incident.slackTs,
    text,
  });
}

export async function replyInThread(
  orgId: number,
  incidentId: number,
  text: string,
  blocks?: unknown[],
): Promise<string | null> {
  const incident = await getIncident(orgId, incidentId);
  if (!incident?.slackTs || !incident.slackChannel) return null;

  const token = await botToken(orgId);
  if (!token) return null;

  const posted = await call<{ ts?: string }>(token, "chat.postMessage", {
    channel: incident.slackChannel,
    thread_ts: incident.slackTs,
    text,
    ...(blocks ? { blocks } : {}),
  });
  if (!posted?.ts) return null;

  const link = await call<{ permalink?: string }>(token, "chat.getPermalink", {
    channel: incident.slackChannel,
    message_ts: posted.ts,
  });
  return link?.permalink ?? null;
}

/** The escalation when a revert fails: verbatim vendor error plus an inline action. */
export async function escalateRevertFailure(
  orgId: number,
  incidentId: number,
  vendorError: string,
): Promise<void> {
  const incident = await getIncident(orgId, incidentId);
  if (!incident) return;
  await replyInThread(
    orgId,
    incidentId,
    "Revert failed — manual recovery needed.",
    buildEscalation(incident, vendorError),
  );
}

async function hasWriteGrant(orgId: number, connector: string): Promise<boolean> {
  const [instance] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, connector),
      ),
    )
    .limit(1);
  if (!instance) return false;

  const secret = await getCredential(
    orgId,
    instance.id,
    "write",
    "api_key",
    "reflex.grant_check",
  );
  return secret !== null;
}

/**
 * The capture prompt, pre-filled with the top impacted node so the question is
 * concrete: "why is deleting vat_rate okay?" beats "add a note".
 */
export async function openAckModal(
  orgId: number,
  triggerId: string,
  incidentId: number,
  changed: string,
  topImpacted: string,
): Promise<void> {
  if (!triggerId) return;
  const token = await botToken(orgId);
  if (!token) return;

  await call(token, "views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "reflex.ack_submit",
      private_metadata: String(incidentId),
      title: { type: "plain_text", text: "Acknowledge" },
      submit: { type: "plain_text", text: "Acknowledge" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          // Optional by design: a forced field produces garbage rationale, and
          // an honourable skip keeps the signal clean.
          optional: true,
          block_id: "reason",
          label: { type: "plain_text", text: `Why was changing ${changed} okay?` },
          hint: {
            type: "plain_text",
            text: `${topImpacted} depends on it. Your answer is saved as permanent, searchable rationale.`,
          },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "It was replaced by … / it was unused since …",
            },
          },
        },
      ],
    },
  });
}

export async function incidentFeed(orgId: number, limit = 50) {
  return db
    .select()
    .from(reflexIncidents)
    .where(eq(reflexIncidents.orgId, orgId))
    .orderBy(reflexIncidents.createdAt)
    .limit(limit);
}
