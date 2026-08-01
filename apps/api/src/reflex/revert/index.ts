import type { ReflexIncident } from "@sadhak/shared/schema";
import { AIRTABLE_REVERT_ACTION, revertAirtableField } from "./airtable.js";
import { N8N_REVERT_ACTION, revertN8nWorkflow } from "./n8n.js";

/**
 * Reverts are the only writes Sadhak ever performs against customer systems,
 * so they run under a **separate, explicitly-granted write credential** —
 * never the read-only crawl grant. A test asserts the executor never requests
 * the read grant.
 *
 * Executors are idempotent per incident: a retry that finds the field or
 * workflow already restored verifies by re-fetching and reports success rather
 * than double-creating.
 */

export type RevertOutcome = { ok: true; detail: string } | { ok: false; error: string };

/**
 * The recovery step an operator needs at 2am, inline. There is no revert
 * runbook to link — Plan 16 is deferred — and a shipped message must never
 * point at a page that does not exist. `alert.ts` refuses to build an
 * escalation whose action string is missing or under 40 characters.
 */
export const REVERT_ACTIONS: Record<string, string> = {
  airtable: AIRTABLE_REVERT_ACTION,
  n8n: N8N_REVERT_ACTION,
};

export function revertActionFor(connector: string): string {
  const action = REVERT_ACTIONS[connector];
  if (!action || action.length < 40) {
    throw new Error(
      `No usable recovery action for connector "${connector}" — refusing to escalate without one`,
    );
  }
  return action;
}

export async function execute(incident: ReflexIncident): Promise<RevertOutcome> {
  switch (incident.connector) {
    case "airtable":
      return revertAirtableField(incident);
    case "n8n":
      return revertN8nWorkflow(incident);
    default:
      return {
        ok: false,
        error: `No revert executor for connector "${incident.connector}"`,
      };
  }
}

export function isRevertible(connector: string): boolean {
  return connector === "airtable" || connector === "n8n";
}
