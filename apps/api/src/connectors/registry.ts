import type { ConnectorInstance } from "@sadhak/shared/schema";
import { CONNECTOR_SLUGS, type ConnectorSlug } from "@sadhak/shared/types";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { Secret } from "../vault/secret.js";
import * as airtable from "./airtable/index.js";
import * as github from "./github/index.js";
import { InstanceHttp } from "./http.js";
import * as n8n from "./n8n/index.js";
import * as postgres from "./postgres/index.js";
import * as slack from "./slack/index.js";
import type { Connector, ReadContext } from "./types.js";

/**
 * Five static imports, no dynamic discovery. Adding a connector is: implement
 * the interface, add one entry here, publish its scopes.
 */

const REGISTRY: Record<ConnectorSlug, Connector> = {
  n8n: n8n.n8nConnector,
  airtable: airtable.airtableConnector,
  postgres: postgres.postgresConnector,
  github: github.githubConnector,
  slack: slack.slackConnector,
};

const HTTP_PROFILE: Record<
  ConnectorSlug,
  {
    defaultBaseUrl: string | null;
    allowedPaths: RegExp[];
    authHeaders: (secret: Secret) => Record<string, string>;
  }
> = {
  n8n: {
    defaultBaseUrl: null, // per-instance; n8n is self-hosted
    allowedPaths: n8n.ALLOWED_PATHS,
    authHeaders: n8n.authHeaders,
  },
  airtable: {
    defaultBaseUrl: "https://api.airtable.com",
    allowedPaths: airtable.ALLOWED_PATHS,
    authHeaders: airtable.authHeaders,
  },
  postgres: {
    defaultBaseUrl: null, // direct connection, not HTTP
    allowedPaths: [],
    authHeaders: () => ({}),
  },
  github: {
    defaultBaseUrl: "https://api.github.com",
    allowedPaths: github.ALLOWED_PATHS,
    authHeaders: github.authHeaders,
  },
  slack: {
    defaultBaseUrl: "https://slack.com",
    allowedPaths: slack.ALLOWED_PATHS,
    authHeaders: slack.authHeaders,
  },
};

export function isConnectorSlug(value: string): value is ConnectorSlug {
  return (CONNECTOR_SLUGS as readonly string[]).includes(value);
}

export function getConnector(slug: string): Connector {
  if (!isConnectorSlug(slug)) {
    throw new UserError(`Unknown connector "${slug}"`);
  }
  return REGISTRY[slug];
}

export function allDescriptors() {
  return CONNECTOR_SLUGS.map((slug) => REGISTRY[slug].descriptor);
}

/**
 * Non-secret config only. The refinement is the firewall: a key that looks
 * like a secret is rejected outright — secrets go to the vault or nowhere.
 */
export const connectorConfigSchema = z
  .record(z.unknown())
  .refine(
    (config) =>
      !Object.keys(config).some((key) => /token|key|secret|password/i.test(key)),
    { message: "Secrets belong in the credential vault, not in connector config" },
  );

export function baseUrlFor(instance: ConnectorInstance): string {
  const configured = instance.config.baseUrl;
  if (typeof configured === "string" && configured) return configured;

  const profile = HTTP_PROFILE[instance.connector as ConnectorSlug];
  if (profile?.defaultBaseUrl) return profile.defaultBaseUrl;

  throw new UserError(`Connector instance ${instance.id} has no baseUrl configured`);
}

/**
 * Read contexts only. There is deliberately no `makeWriteContext` yet: Reflex
 * revert is Plan 9, and until then a write credential has no path into any
 * connector call.
 */
export function makeReadContext(
  orgId: number,
  instance: ConnectorInstance,
  secret: Secret,
  signal?: AbortSignal,
): ReadContext {
  const slug = instance.connector as ConnectorSlug;
  const profile = HTTP_PROFILE[slug];

  const http = new InstanceHttp({
    slug,
    instanceId: instance.id,
    // Postgres never issues HTTP; the placeholder keeps the type honest while
    // the empty allowlist makes any request through it throw.
    baseUrl: slug === "postgres" ? "https://invalid.local" : baseUrlFor(instance),
    secret,
    authHeaders: profile?.authHeaders ?? (() => ({})),
    allowedPaths: profile?.allowedPaths ?? [],
    // n8n is the only connector whose base URL the customer supplies, and the
    // only one that may legitimately be a private http host (the bundled
    // instance on the compose network). Everything else is a fixed vendor
    // domain and is held to public https.
    allowPrivateHttp: slug === "n8n",
  });

  return {
    mode: "read",
    orgId,
    instance,
    http,
    secret,
    ...(signal ? { signal } : {}),
  };
}
