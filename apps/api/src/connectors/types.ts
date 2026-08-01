import type { ConnectorInstance } from "@sadhak/shared/schema";
import type { ConnectorSlug } from "@sadhak/shared/types";
import type { Secret } from "../vault/secret.js";
import type { InstanceHttp } from "./http.js";

export { CONNECTOR_SLUGS } from "@sadhak/shared/types";
export type { ConnectorSlug };

/** Published verbatim in docs/connectors/ — the buyer's security reviewer reads these. */
export interface ScopeSpec {
  scope: string;
  purpose: string;
}

export interface ConnectorDescriptor {
  slug: ConnectorSlug;
  displayName: string;
  auth: "github_app" | "oauth2" | "api_key" | "connection_string";
  readScopes: ScopeSpec[];
  /** Reflex revert only, granted through a separate endpoint. */
  writeScopes: ScopeSpec[];
  webhooks: boolean;
  revertible: boolean;
}

/* ------------------------------------------------------- crawl output */

export type NodeKindName =
  | "workflow"
  | "step"
  | "table"
  | "field"
  | "endpoint"
  | "credential"
  | "service"
  | "report"
  | "person";

export type EdgeKindName =
  | "READS_FROM"
  | "WRITES_TO"
  | "TRIGGERS"
  | "AUTHENTICATES_WITH"
  | "DERIVES_FROM"
  | "OWNED_BY";

/**
 * Connectors emit *specs*, never rows. `llm_inferred` is deliberately absent
 * from `Provenance` here: Cartographer is deterministic ETL, so a model-guessed
 * edge is unrepresentable in connector output at the type level.
 */
export type ConnectorProvenance = "static_parse" | "runtime_observed";

export interface NodeKey {
  connector: string;
  externalId: string;
}

/** A reference to something another connector owns the canonical identity of. */
export type ExternalRef =
  | {
      system: "airtable";
      baseId?: string;
      tableId?: string;
      fieldId?: string;
      tableName?: string;
    }
  | {
      system: "postgres";
      credentialId?: string;
      host?: string;
      database?: string;
      schema: string;
      table: string;
      column?: string;
    }
  | { system: "http"; host: string; path?: string };

export interface NodeSpec {
  key: NodeKey;
  kind: NodeKindName;
  name: string;
  /** Validated per kind with a strict allowlist. No customer row can ride here. */
  metadata: Record<string, unknown>;
}

export interface EdgeSpec {
  src: NodeKey | ExternalRef;
  dst: NodeKey | ExternalRef;
  kind: EdgeKindName;
  provenance: ConnectorProvenance;
}

export interface CrawlResult {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

/* ----------------------------------------------------------- contexts */

interface BaseContext {
  orgId: number;
  instance: ConnectorInstance;
  http: InstanceHttp;
  secret: Secret;
  signal?: AbortSignal;
}

/** Crawl and health only. A write credential can never reach these. */
export interface ReadContext extends BaseContext {
  readonly mode: "read";
}

/** Reflex revert only. */
export interface WriteContext extends BaseContext {
  readonly mode: "write";
}

export interface RevertAction {
  kind: string;
  externalId: string;
  detail: Record<string, unknown>;
}

export interface Connector {
  descriptor: ConnectorDescriptor;
  crawl(ctx: ReadContext): Promise<CrawlResult>;
  health(ctx: ReadContext): Promise<{ ok: boolean; detail?: string }>;
  revert?(
    ctx: WriteContext,
    action: RevertAction,
  ): Promise<{ ok: boolean; detail: string }>;
}
