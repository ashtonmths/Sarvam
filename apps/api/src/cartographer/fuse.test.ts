import { describe, expect, it } from "vitest";
import { emptyCatalog, type FusionCatalog, placeholderFor, resolveRef } from "./fuse.js";

function catalogWith(overrides: Partial<FusionCatalog>): FusionCatalog {
  return { ...emptyCatalog(), ...overrides };
}

describe("rule 1 — exact vendor id", () => {
  it("resolves an Airtable table id straight to its canonical key", () => {
    const result = resolveRef(
      { system: "airtable", tableId: "tblABC123" },
      emptyCatalog(),
    );
    expect(result).toEqual({
      status: "resolved",
      key: { connector: "airtable", externalId: "table/tblABC123" },
      resolvedBy: "vendor_id",
    });
  });

  it("prefers a field id over the table it belongs to", () => {
    const result = resolveRef(
      { system: "airtable", tableId: "tblABC", fieldId: "fldXYZ" },
      emptyCatalog(),
    );
    expect(result).toMatchObject({
      key: { externalId: "field/fldXYZ" },
      resolvedBy: "vendor_id",
    });
  });

  it("resolves without the Airtable base having been crawled yet — order cannot matter", () => {
    const result = resolveRef({ system: "airtable", tableId: "tblNew" }, emptyCatalog());
    expect(result.status).toBe("resolved");
  });
});

describe("rule 2 — connection metadata", () => {
  it("resolves a Postgres schema.table against one crawled instance", () => {
    const catalog = catalogWith({
      postgresTablesByName: new Map([
        ["public.invoices", ["7/db/demo_billing/table/public.invoices"]],
      ]),
    });
    const result = resolveRef(
      { system: "postgres", schema: "public", table: "invoices" },
      catalog,
    );
    expect(result).toMatchObject({
      key: { externalId: "7/db/demo_billing/table/public.invoices" },
      resolvedBy: "connection",
    });
  });

  it("resolves down to a column when the step names one", () => {
    const catalog = catalogWith({
      postgresTablesByName: new Map([
        ["public.invoices", ["7/db/demo_billing/table/public.invoices"]],
      ]),
    });
    const result = resolveRef(
      { system: "postgres", schema: "public", table: "invoices", column: "vat_rate" },
      catalog,
    );
    expect(result).toMatchObject({
      key: { externalId: "7/db/demo_billing/column/public.invoices.vat_rate" },
    });
  });

  it("refuses when the same table exists in two crawled instances", () => {
    const catalog = catalogWith({
      postgresTablesByName: new Map([
        [
          "public.invoices",
          ["7/db/a/table/public.invoices", "9/db/b/table/public.invoices"],
        ],
      ]),
    });
    const result = resolveRef(
      { system: "postgres", schema: "public", table: "invoices" },
      catalog,
    );
    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") expect(result.candidates).toHaveLength(2);
  });
});

describe("rule 3 — unambiguous name, and rule 4 — refuse", () => {
  it("resolves a name that matches exactly one crawled table", () => {
    const catalog = catalogWith({
      airtableTablesByName: new Map([["invoices mirror", ["table/tblMirror"]]]),
    });
    const result = resolveRef(
      { system: "airtable", tableName: "Invoices Mirror" },
      catalog,
    );
    expect(result).toMatchObject({ resolvedBy: "name" });
  });

  it("refuses an ambiguous name rather than guessing", () => {
    const catalog = catalogWith({
      airtableTablesByName: new Map([["invoices", ["table/tbl1", "table/tbl2"]]]),
    });
    const result = resolveRef({ system: "airtable", tableName: "Invoices" }, catalog);
    // A confidently wrong blast radius is worse than an incomplete one.
    expect(result.status).toBe("unresolved");
  });

  it("refuses a name nothing has been crawled for", () => {
    const result = resolveRef({ system: "airtable", tableName: "Ghost" }, emptyCatalog());
    expect(result.status).toBe("unresolved");
  });
});

describe("placeholders keep crawl order irrelevant", () => {
  it("shapes an Airtable table placeholder", () => {
    const placeholder = placeholderFor({
      connector: "airtable",
      externalId: "table/tblABC",
    });
    expect(placeholder.kind).toBe("table");
    expect(placeholder.metadata).toEqual({ placeholder: true });
  });

  it("shapes a Postgres column placeholder as a field", () => {
    const placeholder = placeholderFor({
      connector: "postgres",
      externalId: "7/db/app/column/public.invoices.vat_rate",
    });
    expect(placeholder.kind).toBe("field");
  });
});
