import { connectorInstances, gateDecisions } from "@sadhak/shared/schema";
import type { ChangeDescriptor, VerdictResult } from "@sadhak/shared/types";
import { and, eq } from "drizzle-orm";
import { baseUrlFor, egressOptionsFor } from "../connectors/registry.js";
import { db } from "../db.js";
import { UserError } from "../errors.js";
import type { EgressOptions } from "../net/guard.js";
import { pinnedFetch } from "../net/pinned-fetch.js";
import { getCredential } from "../vault/vault.js";

/**
 * Execute-on-approve.
 *
 * If the agent never holds the write credential, the proxy gate stops being
 * advisory-with-extra-steps: Sadhak evaluates, and only Sadhak executes, under
 * the explicitly-granted write credential — the same separation the crawlers
 * respect in reverse.
 *
 * v1 coverage is deliberately tiny and **non-destructive**: an Airtable field
 * rename and an n8n workflow disable. No deletes, because destructive
 * forwarding waits until there is revert machinery to undo our own mistakes.
 */

export type ExecuteOutcome =
  | { executed: true; detail: string }
  | { executed: false; error: string };

export function isForwardable(change: ChangeDescriptor): boolean {
  if (
    change.target === "field" &&
    change.operation === "rename" &&
    change.connector === "airtable"
  ) {
    return true;
  }
  if (change.target === "workflow" && change.operation === "disable") return true;
  return false;
}

export async function executeChange(
  orgId: number,
  change: ChangeDescriptor,
  result: VerdictResult,
  decisionId: number,
): Promise<ExecuteOutcome> {
  // Execution happens only on APPROVE. A WARN-with-human-approval flow belongs
  // in an approval queue, not in this endpoint.
  if (result.verdict !== "APPROVE") {
    return {
      executed: false,
      error: `Refusing to execute a ${result.verdict} verdict — only APPROVE is forwarded`,
    };
  }

  if (!isForwardable(change)) {
    return {
      executed: false,
      error: `No forwarding executor for ${change.operation} on ${change.target} (${change.connector})`,
    };
  }

  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, change.connector),
      ),
    )
    .limit(1);
  if (!instance) {
    return { executed: false, error: `No ${change.connector} instance connected` };
  }

  const secret = await getCredential(
    orgId,
    instance.id,
    "write",
    "api_key",
    `forward:${decisionId}`,
  );
  if (!secret) {
    return {
      executed: false,
      error: `No write credential granted for ${change.connector} — grant it separately to enable execution`,
    };
  }

  const outcome =
    change.connector === "airtable"
      ? await renameAirtableField(secret.reveal(), change, instance.config)
      : await disableN8nWorkflow(
          secret.reveal(),
          change,
          baseUrlFor(instance),
          egressOptionsFor(instance),
        );

  // The gate decision and the execution outcome are separate facts, which is
  // exactly why this lands on the enforcement row and never touches the
  // verdict's audit row.
  await db
    .update(gateDecisions)
    .set({
      executedAt: outcome.executed ? new Date() : null,
      executionResult: outcome as unknown as Record<string, unknown>,
    })
    .where(eq(gateDecisions.id, decisionId));

  return outcome;
}

async function renameAirtableField(
  token: string,
  change: ChangeDescriptor,
  config: Record<string, unknown>,
): Promise<ExecuteOutcome> {
  if (!("newName" in change) || !change.newName) {
    return { executed: false, error: "A rename needs newName" };
  }

  const baseId = typeof config.baseId === "string" ? config.baseId : null;
  const tableId = typeof config.tableId === "string" ? config.tableId : null;
  const fieldId = change.externalId.replace(/^field\//, "");
  if (!baseId || !tableId) {
    return { executed: false, error: "Instance config lacks baseId/tableId" };
  }

  const res = await pinnedFetch(
    `https://api.airtable.com/v0/meta/bases/${baseId}/tables/${tableId}/fields/${fieldId}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: change.newName }),
    },
    { allowPrivateHosts: [] },
  );

  if (!res.ok) {
    return {
      executed: false,
      error: `Airtable ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }
  return { executed: true, detail: `Renamed field ${fieldId} to "${change.newName}"` };
}

async function disableN8nWorkflow(
  token: string,
  change: ChangeDescriptor,
  baseUrl: string,
  egress: EgressOptions,
): Promise<ExecuteOutcome> {
  const workflowId = change.externalId.replace(/^workflow\//, "").split("/")[0];
  if (!workflowId) return { executed: false, error: "Cannot derive a workflow id" };

  const res = await pinnedFetch(
    `${baseUrl}/api/v1/workflows/${workflowId}/deactivate`,
    { method: "POST", headers: { "X-N8N-API-KEY": token } },
    egress,
  );

  if (!res.ok) {
    return {
      executed: false,
      error: `n8n ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }
  return { executed: true, detail: `Deactivated workflow ${workflowId}` };
}

export function assertNotBothModes(dryRun: boolean, execute: boolean): void {
  if (dryRun && execute) {
    throw new UserError("dry_run and execute are mutually exclusive", { status: 422 });
  }
}
