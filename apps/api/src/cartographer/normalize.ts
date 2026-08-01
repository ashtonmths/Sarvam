import { z } from "zod";
import type { ConnectorProvenance, EdgeSpec, NodeSpec } from "../connectors/types.js";
import { UserError } from "../errors.js";

/**
 * The provenance boundary and the payload firewall. Provenance→confidence is
 * assigned here and nowhere else: a connector cannot claim a confidence, and
 * `llm_inferred` is not in its vocabulary — that provenance belongs to
 * Historian and Reviewer alone.
 */

export const CONFIDENCE = {
  static_parse: 1.0,
  runtime_observed: 0.8,
  llm_inferred: 0.5,
} as const;

export function confidenceFor(provenance: ConnectorProvenance): number {
  return CONFIDENCE[provenance];
}

/**
 * Per-kind metadata allowlists, strict. Unknown keys reject the whole spec —
 * there is no key under which a row of customer data can travel.
 */
const METADATA_SCHEMAS: Record<string, z.ZodTypeAny> = {
  workflow: z
    .object({ active: z.boolean().optional(), updatedAt: z.string().optional() })
    .strict(),
  step: z
    .object({
      nodeType: z.string().optional(),
      idStrategy: z.enum(["uuid", "name"]).optional(),
      webhookPath: z.string().optional(),
    })
    .strict(),
  table: z
    .object({
      database: z.string().optional(),
      schema: z.string().optional(),
      baseId: z.string().optional(),
      relationKind: z.string().optional(),
      placeholder: z.boolean().optional(),
    })
    .strict(),
  field: z
    .object({
      columnType: z.string().optional(),
      isNullable: z.boolean().optional(),
      fieldType: z.string().optional(),
      isComputed: z.boolean().optional(),
      schema: z.string().optional(),
      placeholder: z.boolean().optional(),
    })
    .strict(),
  report: z
    .object({
      database: z.string().optional(),
      schema: z.string().optional(),
      relationKind: z.string().optional(),
    })
    .strict(),
  credential: z.object({ credentialType: z.string().optional() }).strict(),
  service: z
    .object({ airtableKind: z.string().optional(), host: z.string().optional() })
    .strict(),
  endpoint: z
    .object({ host: z.string().optional(), path: z.string().optional() })
    .strict(),
  person: z.object({ email: z.string().optional() }).strict(),
};

const RESOLUTION_KEYS = new Set(["resolvedBy", "placeholder"]);

export interface NormalizedNode {
  connector: string;
  externalId: string;
  kind: NodeSpec["kind"];
  name: string;
  metadata: Record<string, unknown>;
}

export interface NormalizedEdge {
  srcConnector: string;
  srcExternalId: string;
  dstConnector: string;
  dstExternalId: string;
  kind: EdgeSpec["kind"];
  provenance: ConnectorProvenance;
  confidence: number;
}

/**
 * Validates a spec and strips anything not on its kind's allowlist. Throws
 * rather than dropping: a connector emitting row data is a bug worth failing
 * the crawl over, not something to silently sanitize.
 */
export function normalizeNode(spec: NodeSpec): NormalizedNode {
  const schema = METADATA_SCHEMAS[spec.kind];
  if (!schema) {
    throw new UserError(`No metadata schema for node kind "${spec.kind}"`);
  }

  const resolution: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec.metadata ?? {})) {
    if (RESOLUTION_KEYS.has(key)) resolution[key] = value;
    else rest[key] = value;
  }

  const parsed = schema.safeParse(rest);
  if (!parsed.success) {
    const keys = Object.keys(parsed.error.flatten().fieldErrors).join(", ");
    throw new UserError(
      `Rejected ${spec.kind} metadata for "${spec.name}": disallowed or invalid keys (${keys})`,
    );
  }

  if (!spec.key.externalId || !spec.key.connector) {
    throw new UserError(`Node "${spec.name}" is missing its identity key`);
  }

  return {
    connector: spec.key.connector,
    externalId: spec.key.externalId,
    kind: spec.kind,
    name: spec.name,
    metadata: { ...(parsed.data as Record<string, unknown>), ...resolution },
  };
}

/**
 * Edge orientation, enforced here rather than trusted from connectors:
 *
 *   step reads table/field        step   → table/field   READS_FROM
 *   step writes table/field       step   → table/field   WRITES_TO
 *   workflow contains step        workflow → step        DERIVES_FROM
 *   step B consumes A's output    B      → A             TRIGGERS
 *   step uses credential          step   → credential    AUTHENTICATES_WITH
 *   view built from column        view   → column        DERIVES_FROM
 *
 * In every row `src` depends on `dst` — the blast-radius CTE walks dst → src,
 * so getting this backwards produces a confidently wrong answer.
 */
/**
 * How much the *identity resolution* is trusted, as distinct from how the
 * connector learned the reference.
 *
 * An exact vendor id was read literally out of the flow JSON. A name match is
 * an inference: it is right only while no second table shares the name inside
 * the same base. Both used to produce an edge at 1.0, so a guess was
 * indistinguishable from a certainty and there was no way to ask which edges
 * were guessed. The endpoints' resolution now travels into the score.
 */
export const RESOLUTION_CONFIDENCE = {
  vendor_id: 1.0,
  connection: 1.0,
  name: 0.7,
} as const;

export type ResolvedBy = keyof typeof RESOLUTION_CONFIDENCE;

export function normalizeEdge(edge: {
  src: { connector: string; externalId: string };
  dst: { connector: string; externalId: string };
  kind: EdgeSpec["kind"];
  provenance: ConnectorProvenance;
  /** How each endpoint was resolved. Absent means it was already canonical. */
  resolvedBy?: Array<ResolvedBy | undefined>;
}): NormalizedEdge {
  if (
    edge.src.externalId === edge.dst.externalId &&
    edge.src.connector === edge.dst.connector
  ) {
    throw new UserError("An edge cannot point at itself");
  }

  // The weakest endpoint governs: an edge is only as certain as the shakier of
  // the two things it connects.
  const resolutionFactor = (edge.resolvedBy ?? []).reduce(
    (weakest, how) => Math.min(weakest, how ? RESOLUTION_CONFIDENCE[how] : 1.0),
    1.0,
  );

  return {
    srcConnector: edge.src.connector,
    srcExternalId: edge.src.externalId,
    dstConnector: edge.dst.connector,
    dstExternalId: edge.dst.externalId,
    kind: edge.kind,
    provenance: edge.provenance,
    confidence: confidenceFor(edge.provenance) * resolutionFactor,
  };
}
