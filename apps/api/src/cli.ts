import {
  connectorInstances,
  crawls,
  edges as edgesTable,
  nodes as nodesTable,
  organizations,
  unresolvedRefs,
} from "@sadhak/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { runCrawl } from "./cartographer/index.js";
import { closePools, db } from "./db.js";

/**
 * Thin wrappers over the same functions the routes call, so dev and ops see
 * identical behaviour: `sadhak crawl && sadhak graph stats`.
 */

function log(message: string): void {
  console.log(message);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

async function resolveOrgId(): Promise<number> {
  const explicit = flag("org");
  if (explicit) {
    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        /^\d+$/.test(explicit)
          ? eq(organizations.id, Number(explicit))
          : eq(organizations.slug, explicit),
      )
      .limit(1);
    if (!row) throw new Error(`no organization matches "${explicit}"`);
    return row.id;
  }

  const [first] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .orderBy(organizations.id)
    .limit(1);
  if (!first) throw new Error("no organizations exist — run `pnpm seed` first");
  return first.id;
}

async function crawlCommand(): Promise<void> {
  const orgId = await resolveOrgId();
  const instanceFlag = flag("instance");

  const instances = await db
    .select()
    .from(connectorInstances)
    .where(
      instanceFlag
        ? and(
            eq(connectorInstances.orgId, orgId),
            eq(connectorInstances.id, Number(instanceFlag)),
          )
        : eq(connectorInstances.orgId, orgId),
    );

  if (instances.length === 0) {
    log("no connector instances to crawl");
    return;
  }

  for (const instance of instances) {
    if (instance.status === "disabled") {
      log(`${instance.displayName}: skipped (disabled)`);
      continue;
    }
    const outcome = await runCrawl(orgId, instance.id, "full");
    log(
      outcome.state === "succeeded"
        ? `${instance.displayName}: ok — ${JSON.stringify(outcome.stats)}`
        : `${instance.displayName}: FAILED — ${outcome.error}`,
    );
  }
}

async function graphStatsCommand(): Promise<void> {
  const orgId = await resolveOrgId();

  const byKind = await db
    .select({ kind: nodesTable.kind, count: sql<number>`count(*)::int` })
    .from(nodesTable)
    .where(eq(nodesTable.orgId, orgId))
    .groupBy(nodesTable.kind)
    .orderBy(desc(sql`count(*)`));

  const byConnector = await db
    .select({ connector: nodesTable.connector, count: sql<number>`count(*)::int` })
    .from(nodesTable)
    .where(eq(nodesTable.orgId, orgId))
    .groupBy(nodesTable.connector);

  const byProvenance = await db
    .select({ provenance: edgesTable.provenance, count: sql<number>`count(*)::int` })
    .from(edgesTable)
    .where(eq(edgesTable.orgId, orgId))
    .groupBy(edgesTable.provenance);

  const [stale] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nodesTable)
    .where(and(eq(nodesTable.orgId, orgId), eq(nodesTable.state, "stale")));

  const [unresolved] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(unresolvedRefs)
    .where(eq(unresolvedRefs.orgId, orgId));

  const lastCrawls = await db
    .select({
      instance: connectorInstances.displayName,
      state: crawls.state,
      startedAt: crawls.startedAt,
    })
    .from(crawls)
    .innerJoin(connectorInstances, eq(connectorInstances.id, crawls.connectorInstanceId))
    .where(eq(crawls.orgId, orgId))
    .orderBy(desc(crawls.startedAt))
    .limit(5);

  const nodeTotal = byKind.reduce((sum, row) => sum + row.count, 0);
  const edgeTotal = byProvenance.reduce((sum, row) => sum + row.count, 0);

  log(`org #${orgId}`);
  log(`\n${nodeTotal} nodes, ${edgeTotal} edges (${stale?.count ?? 0} stale nodes)`);
  log("\nby kind:");
  for (const row of byKind) log(`  ${row.kind.padEnd(12)} ${row.count}`);
  log("\nby connector:");
  for (const row of byConnector) log(`  ${row.connector.padEnd(12)} ${row.count}`);
  log("\nedges by provenance:");
  for (const row of byProvenance) log(`  ${row.provenance.padEnd(18)} ${row.count}`);
  log(`\nunresolved cross-connector refs: ${unresolved?.count ?? 0}`);
  if (lastCrawls.length > 0) {
    log("\nrecent crawls:");
    for (const row of lastCrawls) {
      log(`  ${row.startedAt.toISOString()}  ${row.state.padEnd(10)} ${row.instance}`);
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "crawl":
      await crawlCommand();
      break;
    case "graph-stats":
      await graphStatsCommand();
      break;
    default:
      log(
        [
          "usage: tsx src/cli.ts <command> [--org <id|slug>] [--instance <id>]",
          "",
          "  crawl        run a full crawl for every connector instance in the org",
          "  graph-stats  node/edge counts by kind, connector, provenance and state",
        ].join("\n"),
      );
  }
}

main()
  .then(() => closePools())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closePools();
    process.exit(1);
  });
