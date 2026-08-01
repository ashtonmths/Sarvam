import type { ReflexIncident } from "@sadhak/shared/schema";
import { connectorInstances, structureSnapshots } from "@sadhak/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { baseUrlFor, egressOptionsFor } from "../../connectors/registry.js";
import { db } from "../../db.js";
import { pinnedFetch } from "../../net/pinned-fetch.js";
import { getCredential } from "../../vault/vault.js";
import type { RevertOutcome } from "./index.js";

/**
 * n8n workflow restore.
 *
 * **Fidelity limit, stated honestly:** this restores the last structure
 * *Sadhak saw*, not n8n's internal version history, which the public API on
 * 1.75.2 does not expose. On the poll path, edits made between two sightings
 * are lost. Push-path instances snapshot on every save, which closes that gap
 * — the confirm dialog shows the snapshot's `capturedAt` so the operator knows
 * exactly what they are restoring to.
 */

export const N8N_REVERT_ACTION =
  "Open the workflow in n8n and restore it from the snapshot timestamp shown on its incident page, or re-click Retry revert once the write-scoped API key is valid again — confirm by the workflow reading active on the next poll.";

export async function revertN8nWorkflow(
  incident: ReflexIncident,
): Promise<RevertOutcome> {
  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, incident.orgId),
        eq(connectorInstances.connector, "n8n"),
      ),
    )
    .limit(1);
  if (!instance) return { ok: false, error: "No n8n connector instance for this org" };

  const secret = await getCredential(
    incident.orgId,
    instance.id,
    "write",
    "api_key",
    `reflex.revert:${incident.id}`,
  );
  if (!secret) {
    return {
      ok: false,
      error: "No write credential granted for n8n — grant revert access to enable this",
    };
  }

  const workflowId = incident.externalId.replace(/^workflow\//, "").split("/")[0];
  if (!workflowId) {
    return {
      ok: false,
      error: `Cannot derive a workflow id from "${incident.externalId}"`,
    };
  }

  const baseUrl = baseUrlFor(instance);
  const headers = {
    "X-N8N-API-KEY": secret.reveal(),
    "content-type": "application/json",
  };

  // A deactivation is undone by reactivating, not by pushing structure back.
  if (incident.operation === "disable") {
    const res = await pinnedFetch(
      `${baseUrl}/api/v1/workflows/${workflowId}/activate`,
      { method: "POST", headers },
      egressOptionsFor(instance),
    );
    if (!res.ok) {
      return {
        ok: false,
        error: `n8n ${res.status}: ${(await res.text()).slice(0, 300)}`,
      };
    }
    return { ok: true, detail: `Reactivated workflow ${workflowId}` };
  }

  // The *previous* snapshot is what we restore — the newest row is the state
  // the change produced, which is precisely what we are undoing.
  const snapshots = await db
    .select()
    .from(structureSnapshots)
    .where(
      and(
        eq(structureSnapshots.orgId, incident.orgId),
        eq(structureSnapshots.connector, "n8n"),
        eq(structureSnapshots.externalId, incident.externalId),
      ),
    )
    .orderBy(desc(structureSnapshots.capturedAt))
    .limit(2);

  const previous = snapshots[1];
  if (!previous) {
    return {
      ok: false,
      error:
        "No prior snapshot to restore from — Sadhak never saw this workflow before the change",
    };
  }

  const res = await pinnedFetch(
    `${baseUrl}/api/v1/workflows/${workflowId}`,
    { method: "PUT", headers, body: JSON.stringify(previous.structure) },
    egressOptionsFor(instance),
  );

  if (!res.ok) {
    return { ok: false, error: `n8n ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }

  return {
    ok: true,
    detail: `Restored workflow ${workflowId} to the structure captured at ${previous.capturedAt.toISOString()}`,
  };
}
