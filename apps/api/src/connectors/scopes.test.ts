import { readFileSync } from "node:fs";
import { CONNECTOR_SLUGS } from "@sadhak/shared/types";
import { describe, expect, it } from "vitest";
import * as airtable from "./airtable/index.js";
import * as n8nConnector from "./n8n/index.js";
import * as postgresConnector from "./postgres/index.js";
import { allDescriptors, connectorConfigSchema, getConnector } from "./registry.js";

describe("registry", () => {
  it("returns a descriptor-complete implementation for every slug", () => {
    for (const slug of CONNECTOR_SLUGS) {
      const connector = getConnector(slug);
      expect(connector.descriptor.slug).toBe(slug);
      expect(typeof connector.crawl).toBe("function");
      expect(typeof connector.health).toBe("function");
    }
  });

  it("throws on an unknown slug rather than returning undefined", () => {
    expect(() => getConnector("stripe")).toThrow();
  });
});

describe("published scopes", () => {
  it("gives every connector at least one read scope with a stated purpose", () => {
    for (const descriptor of allDescriptors()) {
      // Postgres is the exception that proves the rule: it has read scopes too.
      expect(descriptor.readScopes.length).toBeGreaterThan(0);
      for (const scope of [...descriptor.readScopes, ...descriptor.writeScopes]) {
        expect(scope.scope.length).toBeGreaterThan(0);
        expect(scope.purpose.length).toBeGreaterThan(10);
      }
    }
  });

  it("requests no record-read scope anywhere — structure, never payloads", () => {
    const forbidden = /record|data\.records|message.*read|files:read/i;
    for (const descriptor of allDescriptors()) {
      for (const scope of descriptor.readScopes) {
        // Slack's channels:history is the one deliberate exception: mining is
        // restricted to explicitly selected channels (ARCHITECTURE §9).
        if (descriptor.slug === "slack" && scope.scope === "channels:history") continue;
        expect(scope.scope).not.toMatch(forbidden);
      }
    }
  });

  it("keeps the published docs in step with the code", () => {
    const doc = readFileSync(
      new URL("../../../../docs/connectors/README.md", import.meta.url),
      "utf8",
    );
    for (const descriptor of allDescriptors()) {
      for (const scope of descriptor.readScopes) {
        expect(doc).toContain(scope.scope);
      }
    }
  });
});

describe("the URL allowlist is the payload firewall's second layer", () => {
  it("admits the Airtable schema endpoints", () => {
    expect(airtable.ALLOWED_PATHS.some((p) => p.test("/v0/meta/bases"))).toBe(true);
    expect(
      airtable.ALLOWED_PATHS.some((p) => p.test("/v0/meta/bases/appABC/tables")),
    ).toBe(true);
  });

  it("does not admit the Airtable record endpoint — fetching rows is a thrown error", () => {
    expect(airtable.ALLOWED_PATHS.some((p) => p.test("/v0/appABC/tblXYZ"))).toBe(false);
    expect(airtable.ALLOWED_PATHS.some((p) => p.test("/v0/appABC/tblXYZ/recDEF"))).toBe(
      false,
    );
  });

  it("admits only the n8n workflow list", () => {
    expect(
      n8nConnector.ALLOWED_PATHS.some((p) => p.test("/api/v1/workflows?limit=100")),
    ).toBe(true);
    expect(n8nConnector.ALLOWED_PATHS.some((p) => p.test("/api/v1/executions"))).toBe(
      false,
    );
  });
});

describe("the Postgres crawler reads the catalog and nothing else", () => {
  it("issues no query against a non-catalog relation", () => {
    const source = readFileSync(new URL("./postgres/index.ts", import.meta.url), "utf8");
    const queries = source.match(/sql<[^`]*`([^`]+)`/g) ?? [];
    for (const query of queries) {
      const from = query.match(/FROM\s+([a-z_.]+)/gi) ?? [];
      for (const clause of from) {
        expect(clause.toLowerCase()).toMatch(/information_schema|pg_[a-z]+/);
      }
    }
  });

  it("publishes the exact read-only grant a customer must run", () => {
    expect(postgresConnector.SETUP_GRANT).toContain("NOSUPERUSER");
    expect(postgresConnector.SETUP_GRANT).toContain("GRANT USAGE ON SCHEMA");
    // No table SELECT is requested; catalog visibility suffices for structure.
    expect(postgresConnector.SETUP_GRANT).not.toMatch(/GRANT SELECT ON (TABLE|ALL)/i);
  });
});

describe("connector config rejects secrets", () => {
  it("accepts non-secret configuration", () => {
    expect(() =>
      connectorConfigSchema.parse({
        baseUrl: "https://n8n.example.com",
        bases: ["appX"],
      }),
    ).not.toThrow();
  });

  it("refuses anything that looks like a credential — the vault or nowhere", () => {
    for (const key of ["apiKey", "token", "password", "clientSecret"]) {
      expect(() => connectorConfigSchema.parse({ [key]: "oops" })).toThrow();
    }
  });
});
