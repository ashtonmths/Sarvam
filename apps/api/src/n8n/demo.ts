import { connectorInstances } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { runCrawl } from "../cartographer/index.js";
import { postN8nAlert } from "../ci/notify.js";
import { db, sql as raw } from "../db.js";
import { UserError } from "../errors.js";
import { log } from "../log.js";
import { getCredential } from "../vault/vault.js";
import { diagnoseFailure } from "./diagnose.js";
import { pollN8nExecutionFailures } from "./failures.js";
import { signInToN8n } from "./rest.js";

/**
 * The demo, driven from the app instead of from a shell.
 *
 * The same work the seed scripts do, behind two buttons — because on a hosted
 * deployment there is no terminal to run a script in, and "ssh in and run this"
 * is not a demo anyone can give. Everything here goes through n8n's own API, so
 * the workflows exist in a workspace the user can open, and the failure is a
 * real execution rather than a row written to look like one.
 */

const INSTANCE_NAME = "n8n (workspace)";
const FAILING_WORKFLOW = "Quarterly VAT filing — run now";

/** A minimal but valid n8n node. Positions matter only to the editor. */
function node(
  id: string,
  name: string,
  type: string,
  position: [number, number],
  parameters: Record<string, unknown> = {},
) {
  return { id, name, type, typeVersion: 1, position, parameters };
}

/** n8n keys connections by node *name*, not id. */
function chain(...names: string[]) {
  const connections: Record<string, unknown> = {};
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i] as string] = {
      main: [[{ node: names[i + 1], type: "main", index: 0 }]],
    };
  }
  return connections;
}

const WORKFLOWS = [
  {
    name: "Quarterly VAT filing",
    nodes: [
      node("n1", "Every quarter", "n8n-nodes-base.scheduleTrigger", [0, 0], {
        rule: { interval: [{ field: "months", monthsInterval: 3 }] },
      }),
      node("n2", "Postgres · read invoices", "n8n-nodes-base.postgres", [220, 0], {
        operation: "executeQuery",
        query:
          "SELECT i.id, i.customer_id, i.amount_cents, i.vat_rate, i.issued_at, c.country\n  FROM invoices i JOIN customers c ON c.id = i.customer_id\n WHERE i.issued_at >= $1 AND i.issued_at < $2",
      }),
      node("n3", "Group by country", "n8n-nodes-base.itemLists", [440, 0], {
        operation: "summarize",
        fieldsToSplitOut: "country",
      }),
      node("n4", "Build filing CSV", "n8n-nodes-base.convertToFile", [660, 0], {
        operation: "toCsv",
      }),
      node("n5", "Send to finance", "n8n-nodes-base.emailSend", [880, 0], {
        subject: "Quarterly VAT filing",
      }),
    ],
    connections: chain(
      "Every quarter",
      "Postgres · read invoices",
      "Group by country",
      "Build filing CSV",
      "Send to finance",
    ),
  },
  {
    name: "Nightly invoice reconciliation",
    nodes: [
      node("m1", "Nightly at 02:00", "n8n-nodes-base.scheduleTrigger", [0, 0], {
        rule: { interval: [{ field: "days", daysInterval: 1 }] },
      }),
      node("m2", "Postgres · yesterday's invoices", "n8n-nodes-base.postgres", [220, 0], {
        operation: "executeQuery",
        query:
          "SELECT id, amount_cents, currency, vat_rate FROM invoices WHERE issued_at > now() - interval '1 day'",
      }),
      node("m3", "Compare against ledger", "n8n-nodes-base.code", [440, 0], {
        jsCode:
          "// Compares the amount charged against the ledger.\n// Deliberately does NOT compare vat_rate against the live tax service:\n// the column is historical and the service is current, and treating the\n// difference as an error is what caused the eleven-day false alarm.\nreturn items;",
      }),
      node("m4", "Post mismatches", "n8n-nodes-base.slack", [660, 0], {
        select: "channel",
        text: "Reconciliation mismatches",
      }),
    ],
    connections: chain(
      "Nightly at 02:00",
      "Postgres · yesterday's invoices",
      "Compare against ledger",
      "Post mismatches",
    ),
  },
  {
    name: "New customer onboarding",
    nodes: [
      node("o1", "Customer created", "n8n-nodes-base.webhook", [0, 0], {
        path: "customer-created",
        httpMethod: "POST",
      }),
      node("o2", "Postgres · read customer", "n8n-nodes-base.postgres", [220, 0], {
        operation: "executeQuery",
        query: "SELECT id, name, country, created_at FROM customers WHERE id = $1",
      }),
      node("o3", "Welcome email", "n8n-nodes-base.emailSend", [440, -80], {
        subject: "Welcome to Acme",
      }),
      node("o4", "Notify sales", "n8n-nodes-base.slack", [440, 80], {
        select: "channel",
        text: "New customer",
      }),
    ],
    connections: {
      "Customer created": {
        main: [[{ node: "Postgres · read customer", type: "main", index: 0 }]],
      },
      // Fans out, so the graph has a workflow that is not a straight line.
      "Postgres · read customer": {
        main: [
          [
            { node: "Welcome email", type: "main", index: 0 },
            { node: "Notify sales", type: "main", index: 0 },
          ],
        ],
      },
    },
  },
  {
    name: "Dunning — overdue invoice chase",
    nodes: [
      node("d1", "Weekdays at 09:00", "n8n-nodes-base.scheduleTrigger", [0, 0], {
        rule: { interval: [{ field: "days", daysInterval: 1 }] },
      }),
      node("d2", "Postgres · overdue invoices", "n8n-nodes-base.postgres", [220, 0], {
        operation: "executeQuery",
        query:
          "SELECT id, customer_id, amount_cents, currency FROM invoices WHERE issued_at < now() - interval '30 days'",
      }),
      node("d3", "Only above 50 EUR", "n8n-nodes-base.filter", [440, 0], {}),
      node("d4", "Chase email", "n8n-nodes-base.emailSend", [660, 0], {
        subject: "Invoice overdue",
      }),
    ],
    connections: chain(
      "Weekdays at 09:00",
      "Postgres · overdue invoices",
      "Only above 50 EUR",
      "Chase email",
    ),
  },
];

interface Workspace {
  instanceId: number;
  baseUrl: string;
  apiKey: string;
}

/** The org's provisioned n8n, or a plain reason why there isn't one. */
async function workspace(orgId: number): Promise<Workspace> {
  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, "n8n"),
        eq(connectorInstances.displayName, INSTANCE_NAME),
      ),
    )
    .limit(1);

  if (!instance) {
    throw new UserError(
      "No n8n workspace has been provisioned for this organisation yet. That happens on sign-in when N8N_API_KEY is configured on the deployment.",
      { status: 409 },
    );
  }

  const secret = await getCredential(orgId, instance.id, "read", "api_key", "n8n.demo");
  const apiKey = secret?.reveal();
  if (!apiKey) {
    throw new UserError(
      "The n8n workspace has no API key stored yet, so nothing can be written to it.",
      { status: 409 },
    );
  }

  return {
    instanceId: instance.id,
    apiKey,
    baseUrl: String(
      (instance.config as Record<string, unknown>)?.baseUrl ?? "http://n8n:5678",
    ).replace(/\/$/, ""),
  };
}

/**
 * Creates the demo workflows in the org's own n8n, then crawls.
 *
 * Idempotent by name: running it twice updates rather than duplicating, so the
 * button is safe to press during a demo when nobody remembers whether it was
 * already pressed.
 */
export async function createDemoWorkflows(
  orgId: number,
): Promise<{ created: number; updated: number; nodes: number }> {
  const ws = await workspace(orgId);
  const headers = { "X-N8N-API-KEY": ws.apiKey, "content-type": "application/json" };

  const listed = await fetch(`${ws.baseUrl}/api/v1/workflows?limit=250`, { headers });
  if (!listed.ok) {
    throw new UserError(`n8n refused to list workflows (${listed.status}).`, {
      status: 502,
    });
  }
  const existing = (await listed.json()) as {
    data?: Array<{ id: string; name: string }>;
  };
  const byName = new Map((existing.data ?? []).map((w) => [w.name, w.id]));

  let created = 0;
  let updated = 0;

  for (const workflow of WORKFLOWS) {
    const id = byName.get(workflow.name);
    const res = await fetch(
      id ? `${ws.baseUrl}/api/v1/workflows/${id}` : `${ws.baseUrl}/api/v1/workflows`,
      {
        method: id ? "PUT" : "POST",
        headers,
        body: JSON.stringify({
          name: workflow.name,
          nodes: workflow.nodes,
          connections: workflow.connections,
          settings: { executionOrder: "v1" },
        }),
      },
    );
    if (!res.ok) continue;
    if (id) updated += 1;
    else created += 1;
  }

  const crawl = await runCrawl(orgId, ws.instanceId);
  log().info(
    { event: "n8n_demo_workflows", orgId, created, updated },
    "n8n: demo workflows",
  );

  return {
    created,
    updated,
    nodes: (crawl.stats as { nodesSeen?: number } | undefined)?.nodesSeen ?? 0,
  };
}

/**
 * Breaks one on purpose, then runs the real detection and diagnosis over it.
 *
 * Not a seeded row. n8n executes the workflow, the workflow throws, the poller
 * finds it and the diagnosis runs — the same path a genuine failure takes, so
 * what the demo shows is the product working rather than a screenshot of it.
 */

/**
 * The failures worth being able to produce on demand.
 *
 * Each one lands in a different branch of the diagnosis, which is the part
 * worth demonstrating: the pipeline is not one path that always ends in an
 * explanation. A vendor outage should stop before the model and say so; a
 * failure whose fix is already open should recommend the merge and stop; only
 * the schema case should spend a reasoning call.
 */
export const SCENARIOS = {
  schema: {
    label: "Schema change",
    workflow: "Quarterly VAT filing — run now",
    node: "Postgres · read invoices",
    error: 'column "vat_rate" does not exist',
    expect: "diagnosed",
    blurb: "A migration dropped a column the workflow reads.",
  },
  vendor: {
    label: "Vendor outage",
    workflow: "Nightly invoice reconciliation — run now",
    node: "Avalara · fetch rate",
    error: "connect ETIMEDOUT 52.14.221.9:443 — tax service did not respond",
    expect: "unrelated",
    blurb: "Nothing we shipped explains it, so it stops before the model.",
  },
  credential: {
    label: "Expired credential",
    workflow: "New customer onboarding — run now",
    node: "Slack · notify sales",
    error: "invalid_auth — token_revoked",
    expect: "unrelated",
    blurb: "A revoked token. Also ours to notice, not ours to have caused.",
  },
  code: {
    label: "Bad deploy",
    workflow: "Dunning — overdue invoice chase — run now",
    node: "Build chase list",
    error: "TypeError: Cannot read properties of undefined (reading 'amount_cents')",
    expect: "diagnosed",
    blurb: "A shape change in the code the workflow depends on.",
  },
} as const;

export type ScenarioKey = keyof typeof SCENARIOS;

export async function simulateWorkflowFailure(
  orgId: number,
  scenario: ScenarioKey = "schema",
): Promise<{
  failureId: number | null;
  state: string;
  diagnosis: unknown;
  /** Whether Slack accepted it, and if not, why — never a silent nothing. */
  slack: { posted: boolean; reason?: string };
}> {
  const ws = await workspace(orgId);
  const headers = { "X-N8N-API-KEY": ws.apiKey, "content-type": "application/json" };

  const chosen = SCENARIOS[scenario] ?? SCENARIOS.schema;

  const definition = {
    name: chosen.workflow,
    nodes: [
      {
        id: "t1",
        name: "Run it",
        // A schedule trigger rather than a manual one: the public API rejects a
        // workflow whose only trigger is manual. It never fires — the run below
        // is started by hand — but it satisfies the validation.
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: { rule: { interval: [{ field: "months", monthsInterval: 3 }] } },
      },
      {
        id: "t2",
        name: chosen.node,
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [220, 0],
        parameters: {
          // Throws what the real node would throw, so the execution fails the
          // way the incident it stands for actually failed.
          jsCode: `throw new Error(${JSON.stringify(chosen.error)});`,
        },
      },
    ],
    connections: {
      "Run it": { main: [[{ node: chosen.node, type: "main", index: 0 }]] },
    },
    settings: { executionOrder: "v1" },
  };

  const listed = await fetch(`${ws.baseUrl}/api/v1/workflows?limit=250`, { headers });
  const existing = (await listed.json()) as {
    data?: Array<{ id: string; name: string }>;
  };
  const found = (existing.data ?? []).find((w) => w.name === chosen.workflow);

  const saved = await fetch(
    found
      ? `${ws.baseUrl}/api/v1/workflows/${found.id}`
      : `${ws.baseUrl}/api/v1/workflows`,
    { method: found ? "PUT" : "POST", headers, body: JSON.stringify(definition) },
  );
  if (!saved.ok) {
    throw new UserError(`n8n refused to save the workflow (${saved.status}).`, {
      status: 502,
    });
  }
  const workflow = (await saved.json()) as { id: string };

  /**
   * Run it the way the editor does.
   *
   * n8n's public API has no execute endpoint, and activating a webhook over the
   * API does not register its route — the workflow reports active and the URL
   * still answers 404. Signing in and posting to the internal REST API is the
   * same call the "Test workflow" button makes.
   */
  const [account] = (await raw`
    SELECT email FROM n8n_accounts WHERE org_id = ${orgId} LIMIT 1
  `) as unknown as Array<{ email: string }>;
  const pw = await getCredential(
    orgId,
    ws.instanceId,
    "read",
    "n8n_user_password",
    "n8n.demo",
  );
  if (!account || !pw) {
    throw new UserError("No n8n account credentials are stored to sign in with.", {
      status: 409,
    });
  }

  const cookie = await signInToN8n(account.email, pw.reveal());
  await fetch(`${ws.baseUrl}/rest/workflows/${workflow.id}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ workflowData: { ...definition, id: workflow.id } }),
  });

  // n8n writes the execution asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await pollN8nExecutionFailures(orgId);

  const [row] = (await raw`
    SELECT id FROM n8n_execution_failures
    WHERE org_id = ${orgId} AND execution_id < 900000
    ORDER BY detected_at DESC LIMIT 1
  `) as unknown as Array<{ id: number }>;
  if (!row) {
    return {
      failureId: null,
      state: "not_captured",
      diagnosis: null,
      slack: { posted: false, reason: "nothing was captured to post" },
    };
  }

  await diagnoseFailure(Number(row.id));

  const [done] = (await raw`
    SELECT diagnosis_state, diagnosis FROM n8n_execution_failures WHERE id = ${row.id}
  `) as unknown as Array<{ diagnosis_state: string; diagnosis: unknown }>;

  /**
   * Post it. This was missing, and the omission was invisible: the button
   * diagnosed correctly, returned a diagnosis, and never told anyone — so a
   * second run looked like Slack silently dropping a duplicate rather than
   * like the alert never being sent.
   */
  const posted = await postN8nAlert(orgId, Number(row.id));

  return {
    failureId: Number(row.id),
    state: done?.diagnosis_state ?? "unknown",
    diagnosis: done?.diagnosis ?? null,
    slack: posted
      ? { posted: true }
      : {
          posted: false,
          reason:
            "Slack did not accept it. The usual causes are no channel set, the bot not being in the channel, or no Slack connected — the API log records which.",
        },
  };
}
