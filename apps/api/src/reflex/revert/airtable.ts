import type { ReflexIncident } from "@sadhak/shared/schema";
import { connectorInstances, nodes as nodesTable } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { getCredential } from "../../vault/vault.js";
import type { RevertOutcome } from "./index.js";

/**
 * Airtable field recreate.
 *
 * **Fidelity limit, stated everywhere it matters** (docs, the Slack confirm
 * dialog, and the post-revert thread reply): the field's *schema* — name, type,
 * options, select choices — is restored. **Cell data is not.** Airtable's API
 * cannot resurrect deleted cell contents; the base trash can, within its
 * retention window, which is why every surface links it as the
 * higher-fidelity manual path. We recreate schema so dependent flows stop
 * erroring in seconds, and we say exactly that and nothing more.
 */

export const AIRTABLE_REVERT_ACTION =
  "Open the Airtable base trash and restore the field there — trash restore also returns cell data, which recreate cannot. Then re-click Retry revert; the incident closes when the field re-appears.";

const API_BASE = "https://api.airtable.com";

interface FieldSpec {
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

export async function revertAirtableField(
  incident: ReflexIncident,
): Promise<RevertOutcome> {
  const instance = await resolveInstance(incident.orgId, incident.connector);
  if (!instance)
    return { ok: false, error: "No Airtable connector instance for this org" };

  // The write grant is separate and explicit. Its absence is not an error to
  // paper over — the alert already fired; only the button is unavailable.
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
      error:
        "No write credential granted for Airtable — grant revert access to enable this",
    };
  }

  const spec = await fieldSpecFor(incident);
  if (!spec) {
    return { ok: false, error: "No captured field spec to restore from" };
  }

  const { baseId, tableId } = parseExternalId(incident.externalId, incident);
  if (!baseId || !tableId) {
    return { ok: false, error: `Cannot derive base/table from "${incident.externalId}"` };
  }

  const headers = {
    authorization: `Bearer ${secret.reveal()}`,
    "content-type": "application/json",
  };

  // Idempotent: a retry that finds the field already present reports success
  // rather than creating a duplicate.
  const existing = await fetch(`${API_BASE}/v0/meta/bases/${baseId}/tables`, { headers });
  if (existing.ok) {
    const body = (await existing.json()) as {
      tables?: Array<{ id: string; fields?: Array<{ name: string }> }>;
    };
    const table = body.tables?.find((t) => t.id === tableId);
    if (table?.fields?.some((f) => f.name === spec.name)) {
      return { ok: true, detail: `Field "${spec.name}" already present — nothing to do` };
    }
  }

  const res = await fetch(
    `${API_BASE}/v0/meta/bases/${baseId}/tables/${tableId}/fields`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: spec.name,
        type: spec.type,
        ...(spec.options ? { options: spec.options } : {}),
      }),
    },
  );

  if (!res.ok) {
    return {
      ok: false,
      error: `Airtable ${res.status}: ${(await res.text()).slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    detail: `Recreated field "${spec.name}" (${spec.type}). Cell data was not restored — use the base trash for that.`,
  };
}

async function resolveInstance(orgId: number, connector: string) {
  const [row] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, connector),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Field name/type/options captured at last crawl in `nodes.metadata`. */
async function fieldSpecFor(incident: ReflexIncident): Promise<FieldSpec | null> {
  if (incident.nodeId === null) return null;

  const [node] = await db
    .select({ name: nodesTable.name, metadata: nodesTable.metadata })
    .from(nodesTable)
    .where(eq(nodesTable.id, incident.nodeId))
    .limit(1);
  if (!node) return null;

  const meta = node.metadata as { fieldType?: string; options?: Record<string, unknown> };
  const bare = node.name.includes(".")
    ? (node.name.split(".").pop() ?? node.name)
    : node.name;

  return {
    name: bare,
    type: meta.fieldType ?? "singleLineText",
    ...(meta.options ? { options: meta.options } : {}),
  };
}

function parseExternalId(externalId: string, incident: ReflexIncident) {
  // Airtable ids are globally unique and carried in metadata by the crawler.
  const meta = (incident.metadata ?? {}) as { baseId?: string; tableId?: string };
  return {
    baseId: meta.baseId ?? null,
    tableId: meta.tableId ?? externalId.replace(/^field\//, "") ?? null,
  };
}
