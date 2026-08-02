import { connectorInstances } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { runCrawl } from "./cartographer/index.js";
import { closePools, db, sql as raw } from "./db.js";
import { getCredential } from "./vault/vault.js";

/**
 * Real workflows in the demo account's own n8n, not rows pretending to be them.
 *
 * These are created through n8n's public API with the account's own key, so
 * they exist in the workspace a user can open, edit and run. That matters more
 * than it sounds: the crawler reads n8n's API, so seeding the graph directly
 * would produce nodes that vanish on the next crawl. Going through n8n means
 * the map is a mirror of something true, which is the claim the map makes.
 *
 * The set is chosen to continue the story the rest of the seed tells. The
 * quarterly filing reads invoices.vat_rate, which is the column the transcripts
 * argue about and the migration drops — so the workflow that breaks in the
 * seeded failure is a workflow that genuinely exists here.
 */

const ORG_SLUG = "acme-operations";
const INSTANCE_NAME = "n8n (workspace)";

function log(message: string): void {
  console.log(message);
}

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

async function main(): Promise<void> {
  const [org] = (await raw`
    SELECT id FROM organizations WHERE slug = ${ORG_SLUG} LIMIT 1
  `) as unknown as Array<{ id: number }>;
  if (!org) {
    log(`No organisation ${ORG_SLUG}. Run \`pnpm seed\` first.`);
    return;
  }

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

  if (!instance) {
    log("No provisioned n8n workspace for this org. Sign in once so it is created.");
    return;
  }

  const secret = await getCredential(org.id, instance.id, "read", "api_key", "seed");
  const apiKey = secret?.reveal();
  if (!apiKey) {
    log("The workspace has no API key stored yet, so there is nothing to write with.");
    return;
  }

  const baseUrl = String(
    (instance.config as Record<string, unknown>)?.baseUrl ?? "http://n8n:5678",
  ).replace(/\/$/, "");

  // What is already there, so re-running updates rather than duplicating.
  const listed = await fetch(`${baseUrl}/api/v1/workflows?limit=250`, {
    headers: { "X-N8N-API-KEY": apiKey },
  });
  if (!listed.ok) {
    log(`n8n refused to list workflows (${listed.status}). Check the key and base URL.`);
    return;
  }
  const existing = (await listed.json()) as {
    data?: Array<{ id: string; name: string }>;
  };
  const byName = new Map((existing.data ?? []).map((w) => [w.name, w.id]));

  for (const workflow of WORKFLOWS) {
    /**
     * n8n rejects unknown fields on create, and `active` is read-only on this
     * endpoint — activation is a separate call and needs a live trigger, which
     * a demo instance does not have. Left inactive on purpose: an inactive
     * workflow is honest about not running, where an active one that never
     * fires is not.
     */
    const body = JSON.stringify({
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: { executionOrder: "v1" },
    });

    const id = byName.get(workflow.name);
    const res = await fetch(
      id ? `${baseUrl}/api/v1/workflows/${id}` : `${baseUrl}/api/v1/workflows`,
      {
        method: id ? "PUT" : "POST",
        headers: { "X-N8N-API-KEY": apiKey, "content-type": "application/json" },
        body,
      },
    );

    if (!res.ok) {
      log(`  ${workflow.name}: ${res.status} ${(await res.text()).slice(0, 160)}`);
      continue;
    }
    log(
      `  ${workflow.name}: ${id ? "updated" : "created"} (${workflow.nodes.length} steps)`,
    );
  }

  // Crawl immediately, so the map reflects them without waiting for the poller.
  log("");
  log("crawling the workspace so the map picks them up…");
  const result = await runCrawl(org.id, instance.id);
  log(`crawl: ${JSON.stringify(result)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePools);
