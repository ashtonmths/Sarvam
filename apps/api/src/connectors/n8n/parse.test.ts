import { describe, expect, it } from "vitest";
import { externalRefsOf } from "./index.js";

/**
 * The n8n parser is where a mistake becomes a confidently wrong blast radius,
 * so the reference extraction is tested directly against the shapes n8n 1.75
 * actually emits — including its resource-locator objects.
 */

describe("Airtable step references", () => {
  it("extracts base and table ids from resource-locator parameters", () => {
    const refs = externalRefsOf({
      name: "Upsert to Airtable",
      type: "n8n-nodes-base.airtable",
      parameters: {
        operation: "upsert",
        base: { value: "appFinanceOps01", mode: "list" },
        table: { value: "tblInvMirror", mode: "list" },
      },
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]?.writes).toBe(true);
    expect(refs[0]?.ref).toMatchObject({
      system: "airtable",
      baseId: "appFinanceOps01",
      tableId: "tblInvMirror",
    });
  });

  it("treats a non-tbl table value as a name, for older exports", () => {
    const refs = externalRefsOf({
      name: "Read Airtable",
      type: "n8n-nodes-base.airtable",
      parameters: { operation: "list", base: "appX", table: "Invoices Mirror" },
    });
    expect(refs[0]?.ref).toMatchObject({ tableName: "Invoices Mirror" });
    expect(refs[0]?.writes).toBe(false);
  });
});

describe("Postgres step references", () => {
  it("extracts schema and table, defaulting the schema to public", () => {
    const refs = externalRefsOf({
      name: "Write invoices",
      type: "n8n-nodes-base.postgres",
      parameters: { operation: "insert", table: "invoices" },
    });
    expect(refs[0]?.ref).toMatchObject({
      system: "postgres",
      schema: "public",
      table: "invoices",
    });
    expect(refs[0]?.writes).toBe(true);
  });
});

describe("HTTP step references", () => {
  it("keeps host and path but strips the query string, which can carry data", () => {
    const refs = externalRefsOf({
      name: "Charge card",
      type: "n8n-nodes-base.httpRequest",
      parameters: {
        operation: "create",
        url: "https://api.stripe.com/v1/charges?customer_email=priya%40acme.ops&amount=4999",
      },
    });

    expect(refs[0]?.ref).toEqual({
      system: "http",
      host: "api.stripe.com",
      path: "/v1/charges",
    });
    expect(JSON.stringify(refs)).not.toContain("priya");
    expect(JSON.stringify(refs)).not.toContain("4999");
  });

  it("ignores a templated URL it cannot parse rather than guessing", () => {
    const refs = externalRefsOf({
      name: "Dynamic call",
      type: "n8n-nodes-base.httpRequest",
      parameters: { url: "={{$json.endpoint}}" },
    });
    expect(refs).toHaveLength(0);
  });
});

describe("untyped steps", () => {
  it("emits no references for a step that touches nothing external", () => {
    expect(
      externalRefsOf({ name: "Set", type: "n8n-nodes-base.set", parameters: {} }),
    ).toHaveLength(0);
  });
});
