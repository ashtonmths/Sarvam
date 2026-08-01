import { connectorInstances, members, organizations, users } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth/password.js";
import { runCrawl } from "./cartographer/index.js";
import { config } from "./config.js";
import { closePools, db } from "./db.js";
import { putCredential, vaultAvailable } from "./vault/vault.js";

/**
 * Brings a clean database to a demonstrable state: one org, one owner, and
 * connector instances pointed at the systems the dev compose stack already
 * runs — the demo_billing Postgres and, when a key is configured, the local
 * n8n. Idempotent: re-running adopts what already exists.
 */

const DEMO = {
  email: "demo@sadhak.online",
  password: "sadhak-demo-2026",
  name: "Demo User",
  org: "Acme Operations",
};

function log(message: string): void {
  console.log(message);
}

async function main(): Promise<void> {
  const [existingOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, "acme-operations"))
    .limit(1);

  const org =
    existingOrg ??
    (
      await db
        .insert(organizations)
        .values({ name: DEMO.org, slug: "acme-operations" })
        .returning()
    )[0];
  if (!org) throw new Error("failed to create the demo organization");
  log(`org: ${org.name} (#${org.id})`);

  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, DEMO.email))
    .limit(1);

  const user =
    existingUser ??
    (
      await db
        .insert(users)
        .values({
          email: DEMO.email,
          name: DEMO.name,
          passwordHash: await hashPassword(DEMO.password),
          emailVerifiedAt: new Date(),
        })
        .returning()
    )[0];
  if (!user) throw new Error("failed to create the demo user");

  await db
    .insert(members)
    .values({ orgId: org.id, userId: user.id, role: "owner" })
    .onConflictDoNothing();
  log(`user: ${DEMO.email} / ${DEMO.password} (owner)`);

  if (!vaultAvailable()) {
    log(
      "\nCREDENTIAL_MASTER_KEY is not set, so no connector credentials can be stored.\n" +
        'Generate one with:  echo "v1:$(openssl rand -base64 32)"\n' +
        "then re-run `pnpm seed` to connect the demo Postgres and n8n.",
    );
    return;
  }

  // demo_billing: the crawl target whose view dependency is the demo's story.
  const pgInstance = await upsertInstance(org.id, "postgres", "demo_billing", {});
  await putCredential({
    orgId: org.id,
    instanceId: pgInstance.id,
    scope: "read",
    kind: "connection_string",
    value: config.DATABASE_URL.replace(/\/[^/]*$/, "/demo_billing"),
  });
  log(`connector: postgres → demo_billing (#${pgInstance.id})`);

  const pgCrawl = await runCrawl(org.id, pgInstance.id, "full");
  log(
    pgCrawl.state === "succeeded"
      ? `  crawl ok — ${JSON.stringify(pgCrawl.stats)}`
      : `  crawl failed — ${pgCrawl.error}`,
  );

  if (config.N8N_BASE_URL && config.N8N_API_KEY) {
    const n8nInstance = await upsertInstance(org.id, "n8n", "n8n (local)", {
      baseUrl: config.N8N_BASE_URL,
    });
    await putCredential({
      orgId: org.id,
      instanceId: n8nInstance.id,
      scope: "read",
      kind: "api_key",
      value: config.N8N_API_KEY,
    });
    log(`connector: n8n → ${config.N8N_BASE_URL} (#${n8nInstance.id})`);

    const n8nCrawl = await runCrawl(org.id, n8nInstance.id, "full");
    log(
      n8nCrawl.state === "succeeded"
        ? `  crawl ok — ${JSON.stringify(n8nCrawl.stats)}`
        : `  crawl failed — ${n8nCrawl.error}`,
    );
  } else {
    log(
      "n8n: skipped — set N8N_BASE_URL and N8N_API_KEY (mint the key in n8n's\n" +
        "     Settings → API screen; there is no endpoint that issues one).",
    );
  }

  log(
    "\nseed complete. `pnpm --filter @sadhak/api exec tsx src/cli.ts graph-stats` to inspect.",
  );
}

async function upsertInstance(
  orgId: number,
  connector: string,
  displayName: string,
  configValue: Record<string, unknown>,
) {
  const [existing] = await db
    .select()
    .from(connectorInstances)
    .where(eq(connectorInstances.orgId, orgId))
    .then((rows) =>
      rows.filter((r) => r.connector === connector && r.displayName === displayName),
    );
  if (existing) return existing;

  const [created] = await db
    .insert(connectorInstances)
    .values({ orgId, connector, displayName, config: configValue, status: "active" })
    .returning();
  if (!created) throw new Error(`failed to create ${connector} instance`);
  return created;
}

main()
  .then(() => closePools())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error("seed failed:", error);
    await closePools();
    process.exit(1);
  });
