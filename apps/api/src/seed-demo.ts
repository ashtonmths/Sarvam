import { closePools, sql as raw } from "./db.js";
import { seedDemoData } from "./demo/data.js";

/**
 * `pnpm seed:demo`. The work lives in demo/data.ts so the same dataset is
 * reachable from the button on the connectors page, where there is no shell.
 */
const ORG_SLUG = "acme-operations";

async function main(): Promise<void> {
  const [org] = (await raw`
    SELECT id FROM organizations WHERE slug = ${ORG_SLUG} LIMIT 1
  `) as unknown as Array<{ id: number }>;
  if (!org) {
    console.log(`No organisation with slug ${ORG_SLUG}. Run \`pnpm seed\` first.`);
    return;
  }

  console.log(`seeding demo data into org #${org.id}`);
  const { log } = await seedDemoData(org.id);
  for (const line of log) console.log(line);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePools);
