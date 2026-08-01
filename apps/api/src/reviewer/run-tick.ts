import { connectorInstances } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { getConnector, makeReadContext } from "../connectors/registry.js";
import { db } from "../db.js";
import { NotFoundError, UserError } from "../errors.js";
import { getReadCredential } from "../vault/vault.js";
import { collectScopes } from "./collect.js";
import { type TickResult, tick } from "./drift.js";

/**
 * One scheduled drift check for one connector instance.
 *
 * Live structure comes through the same read-only connector client a crawl
 * uses, so the URL allowlists still apply and a tick can never reach a payload
 * endpoint. Reusing the audited read path also means there is one place that
 * fetches from a provider, rather than a second one that has to be kept in
 * step with the first.
 *
 * Not yet done, and worth stating rather than implying: the plan's cheap first
 * pass — an n8n workflow *list* consulted before any detail fetch — is not
 * implemented. A tick currently costs a full structural read. It still costs
 * **zero model requests**, which is the property the quota argument rests on,
 * but the API-call saving is left on the table.
 */
export async function runDriftTick(
  orgId: number,
  instanceId: number,
  signal?: AbortSignal,
): Promise<TickResult> {
  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.id, instanceId), eq(connectorInstances.orgId, orgId)),
    )
    .limit(1);

  if (!instance) throw new NotFoundError("Connector instance not found");
  if (instance.status === "disabled") {
    throw new UserError("This connector instance is disabled");
  }

  const secret = await getReadCredential(orgId, instanceId, `drift:${instanceId}`);
  if (!secret) {
    throw new UserError("No read credential is stored for this connector instance");
  }

  const connector = getConnector(instance.connector);
  const ctx = makeReadContext(orgId, instance, secret, signal);
  const result = await connector.crawl(ctx);

  return tick({
    orgId,
    connectorInstanceId: instanceId,
    entities: collectScopes(result, instance.connector),
  });
}
