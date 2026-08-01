import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  vector,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const nodeKind = pgEnum("node_kind", [
  "workflow",
  "step",
  "table",
  "field",
  "endpoint",
  "credential",
  "service",
  "report",
  "person",
]);

export const edgeKind = pgEnum("edge_kind", [
  "READS_FROM",
  "WRITES_TO",
  "TRIGGERS",
  "AUTHENTICATES_WITH",
  "DERIVES_FROM",
  "OWNED_BY",
]);

/**
 * How an edge was discovered. Load bearing, not metadata: an `llm_inferred`
 * edge can never on its own produce a BLOCK verdict.
 */
export const provenanceKind = pgEnum("provenance_kind", [
  "static_parse", // the name is literally in the flow JSON        confidence 1.0
  "runtime_observed", // we saw the call happen                    confidence 0.8
  "llm_inferred", // a model believes these are related            confidence 0.5
]);

export const sourceKind = pgEnum("source_kind", [
  "slack",
  "pr",
  "commit",
  "doc",
  "human_capture",
]);

/** Only `confirmed` rationale counts toward the coverage metric. */
export const rationaleState = pgEnum("rationale_state", ["drafted", "confirmed"]);

export const jobState = pgEnum("job_state", ["queued", "running", "done", "failed"]);

/* ------------------------------------------------------------------ nodes */

export const nodes = pgTable(
  "nodes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: nodeKind("kind").notNull(),
    /** Human readable, e.g. "Invoices.vat_rate". */
    name: text("name").notNull(),
    /** Stable id in the source system, used to reconcile across crawls. */
    externalId: text("external_id").notNull(),
    connector: text("connector").notNull(),
    /**
     * 1.0 revenue touching, 0.7 customer facing, 0.4 internal, 0.1 sandbox.
     * Seeded by heuristic, then corrected by humans. Those corrections are the
     * compounding proprietary data the moat depends on.
     */
    criticality: real("criticality").notNull().default(0.4),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("nodes_connector_external_id").on(t.connector, t.externalId)],
);

/* ------------------------------------------------------------------ edges */

export const edges = pgTable(
  "edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    srcId: bigint("src_id", { mode: "number" })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    dstId: bigint("dst_id", { mode: "number" })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    kind: edgeKind("kind").notNull(),
    confidence: real("confidence").notNull(),
    provenance: provenanceKind("provenance").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("edges_src_dst_kind").on(t.srcId, t.dstId, t.kind),
    index("edges_src_idx").on(t.srcId),
    // Reverse traversal. Blast radius walks dst -> src, from the thing being
    // changed toward its dependents. Getting this backwards produces a
    // confidently wrong answer, which is worse than no answer.
    index("edges_dst_idx").on(t.dstId),
  ],
);

/* -------------------------------------------------------------- rationale */

export const rationale = pgTable(
  "rationale",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** The quoted span only, never the full channel archive. */
    body: text("body").notNull(),
    /** bge-small-en, computed locally. See apps/api/src/embed.ts */
    embedding: vector("embedding", { dimensions: 384 }),
    sourceKind: sourceKind("source_kind").notNull(),
    /** Permalink. Every claim must point at something a human can click. */
    sourceUrl: text("source_url").notNull(),
    author: text("author"),
    authoredAt: timestamp("authored_at", { withTimezone: true }),
    state: rationaleState("state").notNull().default("drafted"),
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rationale_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("rationale_state_idx").on(t.state),
  ],
);

export const rationaleLinks = pgTable(
  "rationale_links",
  {
    rationaleId: bigint("rationale_id", { mode: "number" })
      .notNull()
      .references(() => rationale.id, { onDelete: "cascade" }),
    edgeId: bigint("edge_id", { mode: "number" })
      .notNull()
      .references(() => edges.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.rationaleId, t.edgeId] })],
);

/* ------------------------------------------------- agent traces and jobs */

/**
 * One row per tool call in a Historian or Reviewer loop. Rendered in the graph
 * UI, so the agent's reasoning path is a product surface and not just a log.
 */
export const agentTraces = pgTable(
  "agent_traces",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id").notNull(),
    agent: text("agent").notNull(),
    step: bigint("step", { mode: "number" }).notNull(),
    tool: text("tool").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_traces_run_idx").on(t.runId, t.step)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    state: jobState("state").notNull().default("queued"),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("jobs_claim_idx").on(t.state, t.runAfter)],
);

/* ------------------------------------------------------- inferred types */

export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type Edge = typeof edges.$inferSelect;
export type NewEdge = typeof edges.$inferInsert;
export type Rationale = typeof rationale.$inferSelect;
export type NewRationale = typeof rationale.$inferInsert;
export type AgentTrace = typeof agentTraces.$inferSelect;
export type Job = typeof jobs.$inferSelect;
