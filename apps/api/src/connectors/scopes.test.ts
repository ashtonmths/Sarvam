import { readFileSync } from "node:fs";
import { CONNECTOR_SLUGS } from "@sadhak/shared/types";
import { describe, expect, it } from "vitest";
import * as airtable from "./airtable/index.js";
import * as n8nConnector from "./n8n/index.js";
import * as postgresConnector from "./postgres/index.js";
import {
  allDescriptors,
  baseUrlFor,
  connectorConfigSchema,
  egressOptionsFor,
  getConnector,
} from "./registry.js";
import { slackConnector } from "./slack/index.js";
import { BOT_SCOPES, USER_SCOPES } from "./slack/oauth.js";

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

describe("slack oauth requests what the descriptor publishes", () => {
  /**
   * The settings page renders the descriptor's scopes verbatim to whoever is
   * reviewing the integration. A scope listed there and not requested is a
   * promise the app cannot keep — and the failure is silent, because Slack
   * answers missing_scope with HTTP 200.
   */
  it("requests every scope the Slack descriptor declares", () => {
    const declared = [
      ...slackConnector.descriptor.readScopes,
      ...slackConnector.descriptor.writeScopes,
    ].map((s) => s.scope);
    const requested = new Set([...BOT_SCOPES, ...USER_SCOPES]);

    const missing = declared.filter((scope) => !requested.has(scope));
    expect(missing).toEqual([]);
  });
});

describe("baseUrlFor", () => {
  const instance = (connector: string, config: Record<string, unknown> = {}) =>
    ({ id: 1, connector, config }) as never;

  /**
   * The bug this pins: a configured baseUrl used to win for every connector,
   * so an admin could point a fixed-vendor instance at a host they control and
   * the next health check would send that org's token there.
   */
  it("ignores a configured baseUrl on connectors whose vendor domain is fixed", () => {
    for (const [slug, vendor] of [
      ["airtable", "https://api.airtable.com"],
      ["github", "https://api.github.com"],
      ["slack", "https://slack.com"],
    ] as const) {
      const hijacked = instance(slug, { baseUrl: "https://collector.attacker.tld" });
      expect(baseUrlFor(hijacked)).toBe(vendor);
    }
  });

  it("honours a configured baseUrl on n8n, which is self-hosted", () => {
    expect(baseUrlFor(instance("n8n", { baseUrl: "https://n8n.acme.internal" }))).toBe(
      "https://n8n.acme.internal",
    );
  });

  it("throws rather than guessing when a self-hosted connector has no baseUrl", () => {
    expect(() => baseUrlFor(instance("n8n"))).toThrow();
  });
});

describe("egressOptionsFor", () => {
  const instance = (connector: string) => ({ id: 1, connector, config: {} }) as never;

  it("refuses private hosts and plain http for fixed-vendor connectors", () => {
    const options = egressOptionsFor(instance("airtable"));
    expect(options.allowHttp).toBe(false);
    // An empty allowlist, not an absent one: absent falls back to the
    // operator's EGRESS_ALLOW_PRIVATE_HOSTS, which exists for the bundled n8n.
    expect(options.allowPrivateHosts).toEqual([]);
  });

  it("allows the bundled n8n to be a private http host", () => {
    const options = egressOptionsFor(instance("n8n"));
    expect(options.allowHttp).toBe(true);
    expect(options.allowPrivateHosts).toBeUndefined();
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
        // restricted to explicitly selected channels.
        if (descriptor.slug === "slack" && scope.scope === "channels:history") continue;
        expect(scope.scope).not.toMatch(forbidden);
      }
    }
  });

  // A third test here kept the published scope table in step with the code.
  // That table lived in a markdown file no longer in the repository, so the
  // assertion has nowhere to point. What it existed to protect is covered by
  // the two tests above: every scope carries a stated purpose, and no
  // descriptor may request a record-read scope.
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

  /**
   * The docs are the copy a customer actually runs, and they had drifted: the
   * page published a blanket `GRANT SELECT ON ALL TABLES IN SCHEMA public`
   * while the code asserted above that it never asks for one. Testing only the
   * constant left the wrong instruction on the website, which is the version
   * that matters — nobody grants privileges by reading a TypeScript file.
   */
  it("never tells a customer to grant a table SELECT", () => {
    const page = readFileSync(
      new URL("../../../web/content/docs/connectors/postgres.mdx", import.meta.url),
      "utf8",
    );
    const sql = page.match(/```sql[\s\S]*?```/g)?.join("\n") ?? "";
    expect(sql).toContain("GRANT USAGE ON SCHEMA");
    expect(sql).not.toMatch(/GRANT SELECT ON (TABLE|ALL)/i);
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
