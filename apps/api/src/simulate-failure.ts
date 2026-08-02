import { connectorInstances } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { postN8nAlert } from "./ci/notify.js";
import { closePools, db, sql as raw } from "./db.js";
import { diagnoseFailure } from "./n8n/diagnose.js";
import { pollN8nExecutionFailures } from "./n8n/failures.js";
import { signInToN8n } from "./n8n/rest.js";
import { getCredential } from "./vault/vault.js";

/**
 * Breaks a workflow for real, then watches the product find it.
 *
 * Deliberately not a seeded row. A failure written straight into the table
 * proves the renderer works and nothing else — the poller, the high-water mark,
 * the capture, the impact traversal and the diagnosis all stay untested, and
 * those are the parts that would be broken in production. Here n8n genuinely
 * executes a workflow, the workflow genuinely throws, and everything after that
 * is the same code path a real failure takes.
 *
 * The error it throws is the one the rest of the demo is about: the VAT column
 * two meetings decided to keep and a migration dropped anyway.
 */

const ORG_SLUG = "acme-operations";
const INSTANCE_NAME = "n8n (workspace)";
const WORKFLOW = "Quarterly VAT filing — run now";

function log(message: string): void {
  console.log(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const [org] = (await raw`
    SELECT id FROM organizations WHERE slug = ${ORG_SLUG} LIMIT 1
  `) as unknown as Array<{ id: number }>;
  if (!org) return log("No demo org. Run `pnpm seed` first.");

  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, org.id),
        eq(connectorInstances.connector, "n8n"),
        eq(connectorInstances.displayName, INSTANCE_NAME),
      ),
    )
    .limit(1);
  if (!instance) return log("No provisioned n8n workspace yet.");

  const secret = await getCredential(org.id, instance.id, "read", "api_key", "simulate");
  const apiKey = secret?.reveal();
  if (!apiKey) return log("No API key stored for the workspace.");

  const baseUrl = String(
    (instance.config as Record<string, unknown>)?.baseUrl ?? "http://n8n:5678",
  ).replace(/\/$/, "");
  const headers = { "X-N8N-API-KEY": apiKey, "content-type": "application/json" };

  /**
   * A webhook trigger, because the public API cannot start a run.
   *
   * n8n's v1 API has no "execute this workflow" endpoint, and a schedule
   * trigger would mean waiting for a clock. A webhook is the one trigger a
   * script can pull, and pulling it produces an ordinary recorded execution —
   * the same kind the poller reads for any other failure.
   */
  const definition = {
    name: WORKFLOW,
    nodes: [
      {
        id: "t1",
        name: "Run filing",
        // A schedule trigger rather than a manual one: the public API rejects
        // a workflow whose only trigger is manual ("no node to start the
        // workflow"). It never actually fires — the run below is started by
        // hand — but it satisfies the validation.
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: { rule: { interval: [{ field: "months", monthsInterval: 3 }] } },
      },
      {
        id: "t2",
        name: "Postgres · read invoices",
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [220, 0],
        parameters: {
          // The real query this stands in for is in the seeded workflow. Here
          // it throws what Postgres would throw once the column is gone, so the
          // execution fails the way the incident actually failed.
          jsCode: `throw new Error('column "vat_rate" does not exist');`,
        },
      },
    ],
    connections: {
      "Run filing": {
        main: [[{ node: "Postgres · read invoices", type: "main", index: 0 }]],
      },
    },
    settings: { executionOrder: "v1" },
  };

  const listed = await fetch(`${baseUrl}/api/v1/workflows?limit=250`, { headers });
  const existing = (await listed.json()) as {
    data?: Array<{ id: string; name: string }>;
  };
  const found = (existing.data ?? []).find((w) => w.name === WORKFLOW);

  const saved = await fetch(
    found ? `${baseUrl}/api/v1/workflows/${found.id}` : `${baseUrl}/api/v1/workflows`,
    { method: found ? "PUT" : "POST", headers, body: JSON.stringify(definition) },
  );
  if (!saved.ok) return log(`could not save: ${saved.status} ${await saved.text()}`);
  const workflow = (await saved.json()) as { id: string };
  log(`1. workflow ready: ${WORKFLOW} (${workflow.id})`);

  /**
   * Run it the way the editor's own "Test workflow" button does.
   *
   * The public API has no execute endpoint, and the webhook route was a dead
   * end: n8n 1.75 accepts an activation over the API, prints the workflow under
   * "Start Active Workflows => Started", and still answers 404 "not registered"
   * for the URL. Rather than fight that, this signs in as the account and posts
   * to n8n's internal REST API — the same call the UI makes, so the execution
   * it produces is an ordinary one.
   */
  const [account] = (await raw`
    SELECT email, n8n_user_id FROM n8n_accounts WHERE org_id = ${org.id} LIMIT 1
  `) as unknown as Array<{ email: string; n8n_user_id: string }>;

  const pw = await getCredential(
    org.id,
    instance.id,
    "read",
    "n8n_user_password",
    "simulate",
  );
  if (!account || !pw) return log("no n8n account credentials stored to sign in with");

  const cookie = await signInToN8n(account.email, pw.reveal());
  log(`2. signed in to n8n as ${account.email}`);

  const ran = await fetch(`${baseUrl}/rest/workflows/${workflow.id}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ workflowData: { ...definition, id: workflow.id } }),
  });
  log(`3. ran it: HTTP ${ran.status}`);

  // n8n writes the execution asynchronously.
  await sleep(2500);

  log("4. polling n8n for failed executions, exactly as the worker does…");
  const captured = await pollN8nExecutionFailures(org.id);
  log(`   captured ${captured} new failure${captured === 1 ? "" : "s"}`);

  const [row] = (await raw`
    SELECT id, workflow_name, failed_node, error_message, diagnosis_state
    FROM n8n_execution_failures
    WHERE org_id = ${org.id} AND execution_id < 900000
    ORDER BY detected_at DESC LIMIT 1
  `) as unknown as Array<{
    id: number;
    workflow_name: string;
    failed_node: string | null;
    error_message: string | null;
    diagnosis_state: string;
  }>;

  if (!row) {
    log("   nothing captured — check that the execution failed in n8n's UI.");
    return;
  }
  log(`   failure #${row.id}: ${row.workflow_name} at ${row.failed_node}`);
  log(`   error: ${row.error_message}`);

  log("5. diagnosing…");
  await diagnoseFailure(row.id);

  const [done] = (await raw`
    SELECT diagnosis_state, diagnosis FROM n8n_execution_failures WHERE id = ${row.id}
  `) as unknown as Array<{ diagnosis_state: string; diagnosis: Record<string, unknown> }>;

  const d = done?.diagnosis as
    | {
        cause?: string;
        recommendation?: string;
        confidence?: number;
        impact?: { count: number };
        windowsSearched?: number;
        searchReach?: string;
        schemaChangeSuspected?: boolean;
      }
    | undefined;

  log("");
  log(`   state          : ${done?.diagnosis_state}`);
  log(`   impact         : ${d?.impact?.count ?? 0} dependants`);
  log(`   windows        : ${d?.windowsSearched} (${d?.searchReach})`);
  log(`   schema change  : ${d?.schemaChangeSuspected}`);
  log(`   cause          : ${d?.cause}`);
  log(`   recommendation : ${d?.recommendation}`);
  log(`   confidence     : ${d?.confidence}`);

  log("");
  log("6. posting to Slack…");
  const posted = await postN8nAlert(org.id, row.id);
  log(
    `   ${posted ? "posted" : "not posted — no Slack channel configured, which is a setting rather than a fault"}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePools);
