import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connectorInstances, nodes as nodesTable } from "@sadhak/shared/schema";
import type { ChangeDescriptor } from "@sadhak/shared/types";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { enqueue } from "../jobs/queue.js";
import { getCredential, getReadCredential, putCredential } from "../vault/vault.js";
import { recordDetection } from "./incidents.js";

/**
 * Airtable's Webhooks API is notification-plus-pull: it POSTs a thin ping, and
 * the actual change payloads are fetched with a cursor. Pings are HMAC-signed
 * with a per-webhook secret, they coalesce under bursts, and **webhooks expire
 * after 7 days unless refreshed** — silent expiry is the failure mode that
 * turns Reflex into a product that quietly stopped working, so the refresh job
 * is not optional.
 */

const AIRTABLE_API = "https://api.airtable.com";
const WEBHOOK_SECRET_KIND = "webhook_secret";
const CURSOR_KEY = "airtableCursor";

export async function registerAirtableWebhook(
  orgId: number,
  instanceId: number,
  baseId: string,
  notificationUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  const secret = await getReadCredential(orgId, instanceId, "airtable.webhook_register");
  if (!secret) return { ok: false, detail: "No Airtable read credential stored" };

  const res = await fetch(`${AIRTABLE_API}/v0/bases/${baseId}/webhooks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret.reveal()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      notificationUrl,
      specification: {
        options: {
          filters: {
            // Structure, never payloads: `tableData` is deliberately absent,
            // so Airtable never sends us a row.
            dataTypes: ["tableFields", "tableMetadata"],
            changeTypes: ["add", "remove", "update"],
          },
        },
      },
    }),
  });

  if (!res.ok) {
    return {
      ok: false,
      detail: `Airtable ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }

  const body = (await res.json()) as { id: string; macSecretBase64: string };

  await putCredential({
    orgId,
    instanceId,
    scope: "read",
    kind: WEBHOOK_SECRET_KIND,
    value: body.macSecretBase64,
  });

  await db
    .update(connectorInstances)
    .set({
      config: { webhookId: body.id, baseId, [CURSOR_KEY]: 0 },
      updatedAt: new Date(),
    })
    .where(eq(connectorInstances.id, instanceId));

  return { ok: true, detail: `Registered webhook ${body.id}` };
}

export async function verifyAirtablePing(
  orgId: number,
  instanceId: number,
  rawBody: string,
  header: string | undefined,
): Promise<boolean> {
  if (!header) return false;

  const secret = await getCredential(
    orgId,
    instanceId,
    "read",
    WEBHOOK_SECRET_KIND,
    "airtable.verify",
  );
  if (!secret) return false;

  const key = Buffer.from(secret.reveal(), "base64");
  const expected = `hmac-sha256=${createHmac("sha256", key).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PayloadsResponse {
  payloads?: Array<{
    timestamp?: string;
    actionMetadata?: {
      sourceMetadata?: { user?: { id?: string; email?: string; name?: string } };
    };
    baseTransactionNumber?: number;
    changedTablesById?: Record<
      string,
      {
        destroyedFieldIds?: string[];
        changedFieldsById?: Record<
          string,
          { current?: { name?: string; type?: string } }
        >;
      }
    >;
    destroyedTableIds?: string[];
  }>;
  cursor?: number;
  mightHaveMore?: boolean;
}

/**
 * Pulls payloads from the stored cursor until exhausted, advancing the cursor
 * with the processed events. A crash re-fetches from the last committed
 * cursor — at-least-once by construction, deduped by the incident key.
 */
export async function fetchAirtablePayloads(
  orgId: number,
  instanceId: number,
): Promise<number> {
  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.id, instanceId), eq(connectorInstances.orgId, orgId)),
    )
    .limit(1);
  if (!instance) return 0;

  const cfg = instance.config as {
    webhookId?: string;
    baseId?: string;
    airtableCursor?: number;
  };
  if (!cfg.webhookId || !cfg.baseId) return 0;

  const secret = await getReadCredential(orgId, instanceId, "airtable.fetch_payloads");
  if (!secret) return 0;

  let cursor = cfg.airtableCursor ?? 0;
  let detected = 0;
  let more = true;
  let pages = 0;

  while (more && pages < 20) {
    const url = `${AIRTABLE_API}/v0/bases/${cfg.baseId}/webhooks/${cfg.webhookId}/payloads?cursor=${cursor}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${secret.reveal()}` },
    });
    if (!res.ok) break;

    const body = (await res.json()) as PayloadsResponse;

    for (const payload of body.payloads ?? []) {
      detected += await processPayload(orgId, payload);
    }

    cursor = body.cursor ?? cursor;
    more = body.mightHaveMore ?? false;
    pages += 1;

    await db
      .update(connectorInstances)
      .set({ config: { ...cfg, airtableCursor: cursor }, updatedAt: new Date() })
      .where(eq(connectorInstances.id, instance.id));
  }

  return detected;
}

async function processPayload(
  orgId: number,
  payload: NonNullable<PayloadsResponse["payloads"]>[number],
): Promise<number> {
  const actor = payload.actionMetadata?.sourceMetadata?.user;
  const changeAt = payload.timestamp ? new Date(payload.timestamp) : null;
  const txn = payload.baseTransactionNumber ?? 0;
  let detected = 0;

  for (const [, table] of Object.entries(payload.changedTablesById ?? {})) {
    for (const fieldId of table.destroyedFieldIds ?? []) {
      detected += await emit(
        orgId,
        `field/${fieldId}`,
        "delete",
        `${txn}:${fieldId}`,
        changeAt,
        actor,
      );
    }
    for (const [fieldId, change] of Object.entries(table.changedFieldsById ?? {})) {
      const operation = change.current?.type ? "retype" : "rename";
      detected += await emit(
        orgId,
        `field/${fieldId}`,
        operation,
        `${txn}:${fieldId}`,
        changeAt,
        actor,
      );
    }
  }

  // A destroyed table fans out to one descriptor per known child field: the
  // blast radius of losing a table is the union of its fields' dependents.
  for (const tableId of payload.destroyedTableIds ?? []) {
    const children = await db
      .select({ externalId: nodesTable.externalId })
      .from(nodesTable)
      .where(
        and(
          eq(nodesTable.orgId, orgId),
          eq(nodesTable.connector, "airtable"),
          eq(nodesTable.kind, "field"),
        ),
      )
      .limit(200);

    for (const child of children) {
      detected += await emit(
        orgId,
        child.externalId,
        "delete",
        `${txn}:${tableId}:${child.externalId}`,
        changeAt,
        actor,
      );
    }
  }

  return detected;
}

async function emit(
  orgId: number,
  externalId: string,
  operation: "delete" | "rename" | "retype",
  vendorEventId: string,
  changeAt: Date | null,
  actor: { id?: string; email?: string; name?: string } | undefined,
): Promise<number> {
  const change: ChangeDescriptor = {
    target: "field",
    operation,
    connector: "airtable",
    externalId,
  };

  const [node] = await db
    .select({ id: nodesTable.id })
    .from(nodesTable)
    .where(
      and(
        eq(nodesTable.orgId, orgId),
        eq(nodesTable.connector, "airtable"),
        eq(nodesTable.externalId, externalId),
      ),
    )
    .limit(1);

  const incidentId = await recordDetection({
    orgId,
    connector: "airtable",
    change,
    vendorEventId,
    changeAt,
    detectPath: "push",
    // An unmapped id (crawl lag) still creates the incident — a change we
    // cannot score is more suspicious, not less.
    nodeId: node?.id ?? null,
    ...(actor
      ? {
          actor: {
            ...(actor.name ? { name: actor.name } : {}),
            ...(actor.email ? { email: actor.email } : {}),
            ...(actor.id ? { vendorUserId: actor.id } : {}),
          },
        }
      : {}),
  });

  if (incidentId === null) return 0;

  await enqueue(
    "reflex.verdict",
    { incidentId },
    { orgId, dedupeKey: `reflex.verdict:${incidentId}`, priority: 5 },
  );
  return 1;
}

/**
 * Refreshes every webhook older than five days. Airtable expires them at
 * seven, and an expired webhook is Reflex silently blind.
 */
export async function refreshAirtableWebhooks(orgId: number): Promise<number> {
  const instances = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, "airtable"),
      ),
    );

  let refreshed = 0;
  for (const instance of instances) {
    const cfg = instance.config as { webhookId?: string; baseId?: string };
    if (!cfg.webhookId || !cfg.baseId) continue;

    const secret = await getReadCredential(
      orgId,
      instance.id,
      "airtable.webhook_refresh",
    );
    if (!secret) continue;

    const res = await fetch(
      `${AIRTABLE_API}/v0/bases/${cfg.baseId}/webhooks/${cfg.webhookId}/refresh`,
      { method: "POST", headers: { authorization: `Bearer ${secret.reveal()}` } },
    );

    if (res.ok) {
      refreshed += 1;
      continue;
    }

    // A webhook found expired is re-created, and the gap is recorded rather
    // than swallowed.
    if (res.status === 404) {
      const url = `https://api.sadhak.online/webhooks/airtable/${instance.id}`;
      await registerAirtableWebhook(orgId, instance.id, cfg.baseId, url);
      await db
        .update(connectorInstances)
        .set({
          statusDetail:
            "Airtable webhook had expired and was re-created — changes in the gap were not detected",
          updatedAt: new Date(),
        })
        .where(eq(connectorInstances.id, instance.id));
    }
  }
  return refreshed;
}

/* --------------------------------------------------------------- n8n */

/**
 * n8n does not sign its outbound webhooks, so we generate a per-instance
 * secret at setup and compare it constant-time. This is bearer-token security,
 * not signature verification, and `docs/connectors/n8n.md` says so plainly.
 */
export async function ensureN8nHookSecret(
  orgId: number,
  instanceId: number,
): Promise<string> {
  const existing = await getCredential(
    orgId,
    instanceId,
    "read",
    "hook_secret",
    "n8n.hook_setup",
  );
  if (existing) return existing.reveal();

  const secret = randomBytes(24).toString("base64url");
  await putCredential({
    orgId,
    instanceId,
    scope: "read",
    kind: "hook_secret",
    value: secret,
  });
  return secret;
}

export async function verifyN8nHook(
  orgId: number,
  instanceId: number,
  header: string | undefined,
): Promise<boolean> {
  if (!header) return false;
  const secret = await getCredential(
    orgId,
    instanceId,
    "read",
    "hook_secret",
    "n8n.verify",
  );
  if (!secret) return false;

  const a = Buffer.from(secret.reveal());
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
