import { edges, nodes, organizations, rationale, verdicts } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closePools, db, sql } from "../db.js";
import { UserError } from "../errors.js";
import { deleteOrg } from "./delete.js";
import { exportOrg } from "./export.js";

/**
 * Export and erasure, against a real database.
 *
 * Both of these are claims made on a public privacy page, and a claim about
 * deletion is exactly the kind that stays true in a unit test with a mocked
 * database and false in production. The cascade being real — every table
 * emptying because Postgres said so, not because a teardown list remembered
 * them — is the whole property, and it only exists at the schema level.
 */

afterAll(async () => {
  await closePools();
});

async function seedOrg(name: string) {
  const [org] = await db.insert(organizations).values({ name, slug: name }).returning();
  if (!org) throw new Error("insert failed");

  const [source] = await db
    .insert(nodes)
    .values({
      orgId: org.id,
      kind: "table",
      name: "orders",
      externalId: `${org.id}/db/x/table/public.orders`,
      connector: "postgres",
    })
    .returning();

  const [target] = await db
    .insert(nodes)
    .values({
      orgId: org.id,
      kind: "report",
      name: "revenue",
      externalId: `${org.id}/db/x/report/revenue`,
      connector: "postgres",
    })
    .returning();

  if (!source || !target) throw new Error("node insert failed");

  await db.insert(edges).values({
    orgId: org.id,
    srcId: source.id,
    dstId: target.id,
    kind: "READS_FROM",
    provenance: "static_parse",
    confidence: 1,
  });

  await db.insert(rationale).values({
    orgId: org.id,
    body: "revenue depends on orders because finance signs off on it monthly",
    sourceKind: "slack",
    sourceUrl: "https://example.slack.com/archives/C1/p1",
  });

  return org;
}

describe("exportOrg", () => {
  it("returns the org's graph and rationale", async () => {
    const org = await seedOrg(`export-test-${Date.now()}`);

    const dump = await exportOrg(org.id);

    expect(dump.organization.id).toBe(org.id);
    expect(dump.graph.nodes).toHaveLength(2);
    expect(dump.graph.edges).toHaveLength(1);
    expect(dump.rationale[0]?.body).toContain("finance signs off");

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("excludes embeddings and credentials", async () => {
    const org = await seedOrg(`export-shape-${Date.now()}`);

    const dump = await exportOrg(org.id);

    // The document's own `notes` explain that embeddings are excluded, so a
    // naive substring search over the whole thing matches that sentence and
    // fails. Search the data instead, which is what the claim is about.
    const { notes: _notes, ...data } = dump;
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("sealed");
    expect(Object.keys(dump.rationale[0] ?? {})).not.toContain("embedding");

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("never reaches into another org", async () => {
    const mine = await seedOrg(`export-mine-${Date.now()}`);
    const theirs = await seedOrg(`export-theirs-${Date.now()}`);

    const dump = await exportOrg(mine.id);

    const ids = dump.graph.nodes.map((node) => node.orgId);
    expect(new Set(ids)).toEqual(new Set([mine.id]));
    expect(dump.rationale).toHaveLength(1);

    await db.delete(organizations).where(eq(organizations.id, mine.id));
    await db.delete(organizations).where(eq(organizations.id, theirs.id));
  });
});

describe("deleteOrg", () => {
  it("refuses when the confirmation name does not match", async () => {
    const org = await seedOrg(`delete-guard-${Date.now()}`);

    await expect(
      deleteOrg({ orgId: org.id, confirmName: "not the name", actor: "test" }),
    ).rejects.toThrow(UserError);

    // Still there. A failed confirmation must not partially delete anything.
    const rows = await db.select().from(nodes).where(eq(nodes.orgId, org.id));
    expect(rows).toHaveLength(2);

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("cascades to every table holding org data", async () => {
    const org = await seedOrg(`delete-cascade-${Date.now()}`);

    await deleteOrg({ orgId: org.id, confirmName: org.name, actor: "test" });

    // Queried directly rather than through the export, so this checks the
    // database rather than the same code path that wrote the rows.
    for (const [label, table] of [
      ["nodes", nodes],
      ["edges", edges],
      ["rationale", rationale],
      ["verdicts", verdicts],
    ] as const) {
      const remaining = await db.select().from(table).where(eq(table.orgId, org.id));
      expect(remaining, `${label} should be empty after cascade`).toHaveLength(0);
    }

    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(orgs).toHaveLength(0);
  });

  it("leaves other organisations untouched", async () => {
    const doomed = await seedOrg(`delete-doomed-${Date.now()}`);
    const survivor = await seedOrg(`delete-survivor-${Date.now()}`);

    await deleteOrg({ orgId: doomed.id, confirmName: doomed.name, actor: "test" });

    const rows = await db.select().from(nodes).where(eq(nodes.orgId, survivor.id));
    expect(rows).toHaveLength(2);

    await db.delete(organizations).where(eq(organizations.id, survivor.id));
  });

  it("empties every org-scoped table, not just the ones named above", async () => {
    // The list above is hand-written and will go stale. This asks the database
    // which tables carry an org_id and checks all of them, so a table added
    // later without a cascade fails here instead of quietly surviving erasure.
    const org = await seedOrg(`delete-sweep-${Date.now()}`);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'org_id' AND table_schema = 'public'
      ORDER BY table_name
    `;

    await deleteOrg({ orgId: org.id, confirmName: org.name, actor: "test" });

    const leaked: string[] = [];
    for (const { table_name } of tables) {
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ${sql(table_name)} WHERE org_id = ${org.id}
      `;
      if ((row?.count ?? 0) > 0) leaked.push(table_name);
    }

    expect(tables.length).toBeGreaterThan(5);
    expect(leaked, "tables still holding data for a deleted org").toEqual([]);
  });
});
