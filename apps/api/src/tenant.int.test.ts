import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, sql } from "./db.js";

/**
 * Tenant isolation, asserted at the layer that holds when the application
 * layer is wrong.
 *
 * Scenario 2 of the threat model is "a forgotten org predicate". Tests that go
 * through the query helpers prove the helpers work; they cannot prove what
 * happens when someone writes a hand-rolled CTE and forgets. These tests go
 * straight to SQL and assert the database itself refuses.
 */

interface OrgFixture {
  orgA: number;
  orgB: number;
  nodeA: number;
  nodeB: number;
}

/** Inserts a node and returns its id, already coerced from bigserial's string. */
async function insertNode(
  orgId: number,
  kind: string,
  name: string,
  externalId: string,
): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO nodes (org_id, kind, name, external_id, connector, criticality)
    VALUES (${orgId}, ${kind}::node_kind, ${name}, ${externalId}, 'postgres', 1)
    RETURNING id
  `;
  if (!row) throw new Error(`failed to insert node ${name}`);
  return Number(row.id);
}

async function seedTwoOrgs(): Promise<OrgFixture> {
  const [a] = await sql<{ id: number }[]>`
    INSERT INTO organizations (name, slug) VALUES ('Org A', 'org-a') RETURNING id
  `;
  const [b] = await sql<{ id: number }[]>`
    INSERT INTO organizations (name, slug) VALUES ('Org B', 'org-b') RETURNING id
  `;
  // bigserial comes back as a string from the driver; coerced once here so the
  // assertions compare numbers to numbers.
  const orgA = Number(a?.id);
  const orgB = Number(b?.id);

  return {
    orgA,
    orgB,
    nodeA: await insertNode(orgA, "table", "a.invoices", "a/db/x/table/invoices"),
    nodeB: await insertNode(orgB, "table", "b.invoices", "b/db/x/table/invoices"),
  };
}

beforeEach(async () => {
  // Cascades to nodes and edges.
  await sql`TRUNCATE organizations CASCADE`;
});

afterAll(async () => {
  await closePools();
});

describe("cross-org edges", () => {
  it("cannot be inserted even with a correct-looking org id", async () => {
    const { orgA, nodeA, nodeB } = await seedTwoOrgs();

    // The shape a forgotten predicate produces: an edge claiming org A, whose
    // destination actually belongs to org B.
    const attempt = sql`
      INSERT INTO edges (org_id, src_id, dst_id, kind, confidence, provenance)
      VALUES (${orgA}, ${nodeA}, ${nodeB}, 'READS_FROM', 1, 'static_parse')
    `;

    await expect(attempt).rejects.toThrow(/edges_dst_org_fk|foreign key/i);
  });

  it("cannot be inserted with the source in the other org", async () => {
    const { orgA, nodeA, nodeB } = await seedTwoOrgs();

    const attempt = sql`
      INSERT INTO edges (org_id, src_id, dst_id, kind, confidence, provenance)
      VALUES (${orgA}, ${nodeB}, ${nodeA}, 'READS_FROM', 1, 'static_parse')
    `;

    await expect(attempt).rejects.toThrow(/edges_src_org_fk|foreign key/i);
  });

  it("allows an edge whose endpoints share the org", async () => {
    const { orgA, nodeA } = await seedTwoOrgs();
    const second = await insertNode(orgA, "field", "a.vat_rate", "a/db/x/col/vat_rate");

    await sql`
      INSERT INTO edges (org_id, src_id, dst_id, kind, confidence, provenance)
      VALUES (${orgA}, ${nodeA}, ${second}, 'READS_FROM', 1, 'static_parse')
    `;

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM edges`;
    expect(rows[0]?.n).toBe(1);
  });
});

describe("org deletion", () => {
  it("takes its nodes and edges with it and leaves the other org intact", async () => {
    const { orgA, orgB, nodeA } = await seedTwoOrgs();
    const second = await insertNode(orgA, "field", "a.vat_rate", "a/db/x/col/vat_rate");
    await sql`
      INSERT INTO edges (org_id, src_id, dst_id, kind, confidence, provenance)
      VALUES (${orgA}, ${nodeA}, ${second}, 'READS_FROM', 1, 'static_parse')
    `;

    await sql`DELETE FROM organizations WHERE id = ${orgA}`;

    const remainingNodes = await sql<{ org_id: number }[]>`SELECT org_id FROM nodes`;
    const remainingEdges = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM edges
    `;

    expect(remainingNodes.map((r) => Number(r.org_id))).toEqual([orgB]);
    expect(remainingEdges[0]?.n).toBe(0);
  });
});
