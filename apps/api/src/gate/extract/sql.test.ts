import { describe, expect, it } from "vitest";
import { extractFromSql, type SqlExtractContext, splitStatements } from "./sql.js";

/**
 * The failure mode that kills an account is a **false BLOCK** from over-eager
 * diff parsing; a missed catch merely costs a save. Every test here checks
 * that the parser errs toward `unknowns`.
 */

const ctx: SqlExtractContext = {
  instanceId: 1,
  database: "demo_billing",
  candidateInstances: 1,
};

describe("recognized DDL", () => {
  it("extracts a dropped column as a field delete with an instance-qualified id", () => {
    const result = extractFromSql(
      "drop-vat-rate.sql",
      "ALTER TABLE invoices DROP COLUMN vat_rate;",
      ctx,
    );
    expect(result.unknowns).toHaveLength(0);
    expect(result.changes).toEqual([
      {
        target: "field",
        connector: "postgres",
        operation: "delete",
        // Postgres names are not globally unique, so the id must carry the
        // instance and database Cartographer wrote under.
        externalId: "1/db/demo_billing/column/public.invoices.vat_rate",
      },
    ]);
  });

  it("honors an explicit schema qualifier", () => {
    const result = extractFromSql(
      "m.sql",
      "ALTER TABLE billing.invoices DROP COLUMN vat_rate;",
      ctx,
    );
    expect(result.changes[0]?.externalId).toBe(
      "1/db/demo_billing/column/billing.invoices.vat_rate",
    );
  });

  it("extracts a rename with its new name", () => {
    const result = extractFromSql(
      "m.sql",
      "ALTER TABLE invoices RENAME COLUMN vat_rate TO tax_rate;",
      ctx,
    );
    expect(result.changes[0]).toMatchObject({ operation: "rename", newName: "tax_rate" });
  });

  it("extracts a type change", () => {
    const result = extractFromSql(
      "m.sql",
      "ALTER TABLE invoices ALTER COLUMN vat_rate TYPE numeric(5,2);",
      ctx,
    );
    expect(result.changes[0]).toMatchObject({
      operation: "retype",
      newType: "numeric(5,2)",
    });
  });

  it("handles quoted identifiers and IF EXISTS", () => {
    const result = extractFromSql(
      "m.sql",
      'ALTER TABLE IF EXISTS "public"."invoices" DROP COLUMN IF EXISTS "vat_rate";',
      ctx,
    );
    expect(result.changes[0]?.externalId).toBe(
      "1/db/demo_billing/column/public.invoices.vat_rate",
    );
  });
});

describe("conservative by construction", () => {
  it("routes table-level changes to unknowns — no representable descriptor", () => {
    const result = extractFromSql("m.sql", "DROP TABLE invoices;", ctx);
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns[0]?.reason).toMatch(/table-level/);
  });

  it("routes a view drop to unknowns too", () => {
    const result = extractFromSql("m.sql", "DROP VIEW eu_vat_report;", ctx);
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns).toHaveLength(1);
  });

  it("refuses to attribute a migration when no Postgres instance is connected", () => {
    // Guessing which instance a migration targets is exactly the over-eager
    // interpretation that produces a false BLOCK.
    const result = extractFromSql("m.sql", "ALTER TABLE invoices DROP COLUMN vat_rate;", {
      instanceId: null,
      database: null,
      candidateInstances: 0,
    });
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns[0]?.reason).toMatch(/cannot attribute/);
  });

  it("refuses when several instances could match", () => {
    const result = extractFromSql("m.sql", "ALTER TABLE invoices DROP COLUMN vat_rate;", {
      instanceId: null,
      database: null,
      candidateInstances: 3,
    });
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns[0]?.reason).toMatch(/3 connected databases/);
  });

  it("reports unrecognized ALTER TABLE forms rather than guessing", () => {
    const result = extractFromSql(
      "m.sql",
      "ALTER TABLE invoices ADD CONSTRAINT x CHECK (a > 0);",
      ctx,
    );
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns[0]?.reason).toMatch(/unrecognized DDL/);
  });

  it("ignores statements that are not graph changes at all", () => {
    // A CREATE INDEX is irrelevant, not "not understood" — flagging it would
    // fill the check summary with noise.
    const result = extractFromSql(
      "m.sql",
      "CREATE INDEX idx ON invoices (vat_rate); INSERT INTO invoices VALUES (1);",
      ctx,
    );
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns).toHaveLength(0);
  });

  it("extracts what it understands from a mixed migration and flags the rest", () => {
    const result = extractFromSql(
      "mixed.sql",
      `ALTER TABLE invoices DROP COLUMN vat_rate;
       DROP TABLE legacy_audit;
       ALTER TABLE invoices ADD CONSTRAINT nope CHECK (x);`,
      ctx,
    );
    expect(result.changes).toHaveLength(1);
    expect(result.unknowns).toHaveLength(2);
  });
});

describe("statement splitting", () => {
  it("strips comments and splits on real statement boundaries", () => {
    const statements = splitStatements(`
      -- drop the column
      ALTER TABLE invoices DROP COLUMN vat_rate;
      /* block comment; with a semicolon */
      ALTER TABLE invoices DROP COLUMN currency;
    `);
    expect(statements).toHaveLength(2);
  });

  it("does not split on a semicolon inside a string literal", () => {
    const statements = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    expect(statements).toHaveLength(2);
  });
});
