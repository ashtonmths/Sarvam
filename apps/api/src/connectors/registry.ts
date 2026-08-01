import type { ConnectorInstance } from "@sadhak/shared/schema";
import { CONNECTOR_SLUGS, type ConnectorSlug } from "@sadhak/shared/types";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { EgressOptions } from "../net/guard.js";
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

/**
 * `customerBaseUrl` is a security property, not a convenience one.
 *
 * The vault is write-only by design, but a connector that sends its bearer
 * token to an address the customer chooses hands that token back out. Only
 * self-hosted connectors, whose address genuinely is customer infrastructure,
 * may set it. For everything else the vendor domain is fixed here and
 * `config.baseUrl` is ignored, so setting it cannot redirect a credential.
 *
 * `allowPrivateHttp` travels with it for the same reason: the bundled n8n on
 * the compose network is a legitimate private http host, and nothing else is.
 */
const HTTP_PROFILE: Record<
  ConnectorSlug,
  {
    defaultBaseUrl: string | null;
    customerBaseUrl: boolean;
    allowPrivateHttp: boolean;
    allowedPaths: RegExp[];
    authHeaders: (secret: Secret) => Record<string, string>;
  }
> = {
  n8n: {
    defaultBaseUrl: null, // per-instance; n8n is self-hosted
    customerBaseUrl: true,
    allowPrivateHttp: true,
    allowedPaths: n8n.ALLOWED_PATHS,
    authHeaders: n8n.authHeaders,
  },
  airtable: {
    defaultBaseUrl: "https://api.airtable.com",
    customerBaseUrl: false,
    allowPrivateHttp: false,
    allowedPaths: airtable.ALLOWED_PATHS,
    authHeaders: airtable.authHeaders,
  },
  postgres: {
    defaultBaseUrl: null, // direct connection, not HTTP
    customerBaseUrl: false,
    allowPrivateHttp: false,
    allowedPaths: [],
    authHeaders: () => ({}),
  },
  github: {
    defaultBaseUrl: "https://api.github.com",
    customerBaseUrl: false,
    allowPrivateHttp: false,
    allowedPaths: github.ALLOWED_PATHS,
    authHeaders: github.authHeaders,
  },
  slack: {
    defaultBaseUrl: "https://slack.com",
    customerBaseUrl: false,
    allowPrivateHttp: false,
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
  const profile = HTTP_PROFILE[instance.connector as ConnectorSlug];

  // Only where the descriptor says the address is the customer's own. A
  // configured baseUrl on a fixed-vendor connector is ignored rather than
  // rejected, so an instance stored before this rule existed keeps working
  // against the real vendor instead of failing closed on a stale key.
  if (profile?.customerBaseUrl) {
    const configured = instance.config.baseUrl;
    if (typeof configured === "string" && configured) return configured;
  }

  if (profile?.defaultBaseUrl) return profile.defaultBaseUrl;

  throw new UserError(`Connector instance ${instance.id} has no baseUrl configured`);
}

/**
 * Egress options for the calls that cannot go through `InstanceHttp`.
 *
 * `InstanceHttp` is GET-only, so every write, revert and webhook registration
 * had to be written as a direct call — and each one silently lost the egress
 * guard along with the rate limiter. Deriving the options from the same
 * profile here is what stops the two paths disagreeing about which hosts a
 * connector may reach: without it, whether a customer-supplied base URL can
 * point at the metadata endpoint depends on which function happens to run.
 *
 * Pair this with `pinnedFetch`, never with bare `fetch`.
 */
export function egressOptionsFor(instance: ConnectorInstance): EgressOptions {
  const profile = HTTP_PROFILE[instance.connector as ConnectorSlug];
  const allowPrivate = profile?.allowPrivateHttp ?? false;
  return {
    allowHttp: allowPrivate,
    ...(allowPrivate ? {} : { allowPrivateHosts: [] }),
  };
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
    allowPrivateHttp: profile?.allowPrivateHttp ?? false,
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
