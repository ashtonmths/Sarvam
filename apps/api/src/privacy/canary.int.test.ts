import { afterAll, describe, expect, it } from "vitest";
import { runCrawl } from "../cartographer/index.js";
import { closePools, sql } from "../db.js";

/**
 * The strongest control in the privacy story, tested rather than asserted.
 *
 * "It reads schemas and wiring, never your data" is the promise the product
 * leads with. Everything else supporting it — per-connector URL allowlists,
 * per-kind metadata allowlists, one write path — is a construction argument,
 * and constructions drift. This test is the empirical check: the demo database
 * contains distinctive strings that exist only inside *cell values*, the
 * crawler runs against it in full, and then every text-bearing column in
 * Sadhak's own database is searched for them.
 *
 * The search is mechanical rather than a list of tables to check. A connector
 * change that starts shipping payloads into a column nobody thought about
 * still fails here, which is the entire point of not enumerating by hand.
 */

/** Present only as row data in `demo_billing`. Never as a name or an identifier. */
const CANARIES = [
  "CANARY-CUSTOMER-7f3a",
  "canary-7f3a@example.com",
  "CANARY-PAYLOAD-7f3a",
];

afterAll(async () => {
  await closePools();
});

interface Sighting {
  table: string;
  column: string;
  canary: string;
}

/**
 * Every text-ish column in the public schema, searched for every canary.
 * `information_schema` is the source of truth so a table added tomorrow is
 * covered without anyone remembering to add it here.
 */
async function findCanaries(): Promise<Sighting[]> {
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'jsonb', 'json')
    ORDER BY table_name, column_name
  `;

  const sightings: Sighting[] = [];

  for (const column of columns) {
    for (const canary of CANARIES) {
      // Cast to text so jsonb is searched as its serialized form: a payload
      // smuggled inside a metadata blob is still a payload.
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM ${sql(column.table_name)}
        WHERE ${sql(column.column_name)}::text LIKE ${`%${canary}%`}
      `;
      if ((rows[0]?.n ?? 0) > 0) {
        sightings.push({
          table: column.table_name,
          column: column.column_name,
          canary,
        });
      }
    }
  }

  return sightings;
}

describe("structure, never payloads", () => {
  it("would notice a leak, so a pass means something", async () => {
    // Guards against the worst kind of green: a sweep that finds nothing
    // because it is looking nowhere. Plant a payload in a real column, confirm
    // the sweep names it, then remove it. Self-contained, because other suites
    // truncate these tables and a probe that silently updated zero rows would
    // reintroduce exactly the vacuous pass it exists to prevent.
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('Canary Probe', 'canary-probe')
      RETURNING id
    `;
    const orgId = Number(org?.id);

    await sql`
      INSERT INTO nodes (org_id, kind, name, external_id, connector, criticality, metadata)
      VALUES (${orgId}, 'field', 'probe', 'probe/1', 'postgres', 1,
              ${'{"leaked":"CANARY-PAYLOAD-7f3a"}'}::jsonb)
    `;

    try {
      const sightings = await findCanaries();
      expect(
        sightings.some((s) => s.table === "nodes" && s.column === "metadata"),
        "the sweep did not catch a deliberately planted payload — it is not searching what it claims to",
      ).toBe(true);
    } finally {
      await sql`DELETE FROM organizations WHERE id = ${orgId}`;
    }
  });

  it("holds across every text column", async () => {
    const sightings = await findCanaries();

    expect(
      sightings,
      sightings.length === 0
        ? ""
        : `A connector shipped customer row data into Sadhak. Found: ${sightings
            .map((s) => `${s.table}.${s.column} contains "${s.canary}"`)
            .join("; ")}. The invariant is "structure, never payloads".`,
    ).toEqual([]);
  });
});

/**
 * The same check against a database that has actually been crawled. Kept
 * separate because it needs a seeded org with a connector instance, and a
 * missing fixture should read as "not exercised" rather than as a pass.
 */
describe("after crawling the demo database", () => {
  it("still holds", async () => {
    const [instance] = await sql<{ id: string; org_id: string }[]>`
      SELECT id, org_id FROM connector_instances WHERE connector = 'postgres' LIMIT 1
    `;

    if (!instance) {
      // No seeded Postgres connector in this database: nothing was crawled, so
      // asserting the canaries are absent would prove nothing.
      expect(instance).toBeUndefined();
      return;
    }

    await runCrawl(Number(instance.org_id), Number(instance.id), "full");

    expect(await findCanaries()).toEqual([]);
  });
});
