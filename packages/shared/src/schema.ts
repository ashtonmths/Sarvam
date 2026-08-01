import {
  bigint,
  bigserial,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import type { BlastRow, Evidence } from "./types.js";

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
export const rationaleState = pgEnum("rationale_state", [
  "drafted",
  "confirmed",
  /** Kept, never deleted — draft acceptance rate is a quality metric. */
  "rejected",
]);

export const gateMode = pgEnum("gate_mode", [
  "hard_gate",
  "proxy_gate",
  "mcp",
  "forward",
]);

export const incidentState = pgEnum("incident_state", [
  "detected",
  "alerted",
  "acknowledged",
  "reverting",
  "reverted",
  "revert_failed",
]);

export const historianRunState = pgEnum("historian_run_state", [
  "queued",
  "running",
  "done",
  "cancelled",
]);

export const jobState = pgEnum("job_state", [
  "queued",
  "running",
  "done",
  "failed",
  "dead_letter",
]);

/** A crawled entity that stopped appearing is tombstoned, never deleted. */
export const entityState = pgEnum("entity_state", ["active", "stale"]);

/** Where a drift finding came from. Three sources, one queue. */
export const driftKind = pgEnum("drift_kind", [
  "hash_change",
  "staleness",
  "unresolved_ref",
]);

/**
 * `auto_dismissed` is distinct from `dismissed` on purpose: the first was
 * suppressed by a prior judgment, the second *is* the judgment. Collapsing
 * them would make the mute self-reinforcing with nobody ever having decided.
 */
export const findingState = pgEnum("finding_state", [
  "open",
  "investigating",
  "corrected",
  "dismissed",
  "auto_dismissed",
]);

export const memberRole = pgEnum("member_role", ["owner", "admin", "member", "viewer"]);

export const connectorStatus = pgEnum("connector_status", [
  "pending_auth",
  "active",
  "degraded",
  "error",
  "disabled",
]);

/** Read credentials crawl; write credentials revert. Never the same row. */
export const credentialScope = pgEnum("credential_scope", ["read", "write"]);

/**
 * `auth` is deliberately opt-out-*able* nowhere: a verification link or a
 * password reset is transactionally necessary, and suppressing it breaks the
 * account rather than respecting a preference. No preference row is ever
 * written for it.
 */
export const emailCategory = pgEnum("email_category", ["auth", "lifecycle", "digest"]);

export const crawlState = pgEnum("crawl_state", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

/* ---------------------------------------------------------- organizations */

export const organizations = pgTable("organizations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** External identifier for URLs and API keys — never leak the sequence. */
  publicId: uuid("public_id").notNull().defaultRandom().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------- identity (plan 4) */

export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  publicId: uuid("public_id").notNull().defaultRandom().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** scrypt: `scrypt$N$r$p$salt$hash`, salt and hash base64. */
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** SHA-256 of the cookie token. The token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Active org for this session; switching orgs writes here. */
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "cascade",
    }),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const members = pgTable(
  "members",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("members_org_user").on(t.orgId, t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: bigint("invited_by", { mode: "number" }).references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invitations_org_idx").on(t.orgId, t.email)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the full key. Plaintext is shown exactly once, at creation. */
    keyHash: text("key_hash").notNull().unique(),
    /** `sadhak_a1b2c3…` — enough to identify a key in a list, never to use it. */
    prefix: text("prefix").notNull(),
    /** Capability slugs from `rbac.ts`; may never exceed the creator's own. */
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdBy: bigint("created_by", { mode: "number" }).references(() => users.id),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_keys_org_idx").on(t.orgId)],
);

/** Append-only. An audit log with an UPDATE path is a diary. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "cascade",
    }),
    actorType: text("actor_type").notNull(), // 'user' | 'api_key' | 'system'
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(), // dot-namespaced: auth.signin, connector.tested…
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_org_time_idx").on(t.orgId, t.createdAt)],
);

/* ---------------------------------------------------- connectors (plan 5) */

export const connectorInstances = pgTable(
  "connector_instances",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    displayName: text("display_name").notNull(),
    /** Non-secret config only: base URL, selected bases/schemas. Never tokens. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: connectorStatus("status").notNull().default("pending_auth"),
    statusDetail: text("status_detail"),
    crawlFrequencyMinutes: integer("crawl_frequency_minutes").notNull().default(30),
    lastCrawlAt: timestamp("last_crawl_at", { withTimezone: true }),
    lastCrawlError: text("last_crawl_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    breakerOpenUntil: timestamp("breaker_open_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("connector_instances_org_slug_name").on(t.orgId, t.connector, t.displayName),
  ],
);

export const connectorCredentials = pgTable(
  "connector_credentials",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    instanceId: bigint("instance_id", { mode: "number" })
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    scope: credentialScope("scope").notNull(),
    kind: text("kind").notNull(), // api_key | connection_string | webhook_secret…
    keyId: text("key_id").notNull(),
    /** base64(IV ‖ GCM tag ‖ ciphertext). AAD binds it to org+instance+scope+kind. */
    sealed: text("sealed").notNull(),
    /** Last 4 chars of the plaintext, so a human can tell which key this is. */
    fingerprint: text("fingerprint").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: bigint("created_by", { mode: "number" }).references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [
    unique("connector_credentials_instance_scope_kind").on(t.instanceId, t.scope, t.kind),
  ],
);

/* ---------------------------------------------------------------- nodes */

export const nodes = pgTable(
  "nodes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: nodeKind("kind").notNull(),
    /** Human readable, e.g. "Invoices.vat_rate". */
    name: text("name").notNull(),
    /** Stable id in the source system, used to reconcile across crawls. */
    externalId: text("external_id").notNull(),
    connector: text("connector").notNull(),
    connectorInstanceId: bigint("connector_instance_id", { mode: "number" }).references(
      () => connectorInstances.id,
      { onDelete: "set null" },
    ),
    /**
     * 1.0 revenue touching, 0.7 customer facing, 0.4 internal, 0.1 sandbox.
     * Seeded by heuristic, then corrected by humans. Those corrections are the
     * compounding proprietary data the moat depends on.
     */
    criticality: real("criticality").notNull().default(0.4),
    /** `human` freezes the value: no re-crawl may ever clobber a correction. */
    criticalitySource: text("criticality_source").notNull().default("heuristic"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    state: entityState("state").notNull().default("active"),
    staleSince: timestamp("stale_since", { withTimezone: true }),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("nodes_org_connector_external_id").on(t.orgId, t.connector, t.externalId),
    // Composite-FK target: lets `edges` prove both endpoints share one org.
    unique("nodes_id_org").on(t.id, t.orgId),
    index("nodes_org_state_idx").on(t.orgId, t.state),
  ],
);

/* ------------------------------------------------------------------ edges */

export const edges = pgTable(
  "edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    srcId: bigint("src_id", { mode: "number" }).notNull(),
    dstId: bigint("dst_id", { mode: "number" }).notNull(),
    kind: edgeKind("kind").notNull(),
    confidence: real("confidence").notNull(),
    provenance: provenanceKind("provenance").notNull(),
    state: entityState("state").notNull().default("active"),
    staleSince: timestamp("stale_since", { withTimezone: true }),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("edges_src_dst_kind").on(t.srcId, t.dstId, t.kind),
    // An edge whose endpoints live in different orgs cannot be inserted, no
    // matter what bug produces it.
    foreignKey({
      columns: [t.srcId, t.orgId],
      foreignColumns: [nodes.id, nodes.orgId],
      name: "edges_src_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.dstId, t.orgId],
      foreignColumns: [nodes.id, nodes.orgId],
      name: "edges_dst_org_fk",
    }).onDelete("cascade"),
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
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The quoted span only, never the full channel archive. */
    body: text("body").notNull(),
    /** bge-small-en, computed locally. See apps/api/src/embed.ts */
    embedding: vector("embedding", { dimensions: 384 }),
    sourceKind: sourceKind("source_kind").notNull(),
    /** Permalink. Every claim must point at something a human can click. */
    sourceUrl: text("source_url").notNull(),
    author: text("author"),
    authoredAt: timestamp("authored_at", { withTimezone: true }),
    /** The agent's own confidence, for reviewer triage. Null for human capture. */
    confidence: real("confidence"),
    state: rationaleState("state").notNull().default("drafted"),
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rationale_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("rationale_org_state_idx").on(t.orgId, t.state),
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

/* -------------------------------------------------------------- documents */

/**
 * Uploaded evidence: meeting transcripts, design notes, anything written down
 * outside a system Sadhak can crawl.
 *
 * This is the one place Sadhak keeps an archive rather than a pointer, and it
 * is deliberate. Everywhere else a permalink belongs to a vendor who will
 * still serve it; here there is no vendor, so if we do not store the text
 * there is nothing for a reviewer to click through to and no way to check that
 * a quoted span really appears in its source.
 */
export const documents = pgTable(
  "documents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** The filename as uploaded, kept for recognisability in the list. */
    originalName: text("original_name"),
    /** Normalized text. Offsets in document_chunks index into this exactly. */
    content: text("content").notNull(),
    /** sha256 of `content`. Makes a retried upload idempotent, not duplicated. */
    contentHash: text("content_hash").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** When the meeting happened, if the uploader knows. Not the upload time. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** Where it came from, for provenance. Citations never point here. */
    sourceUrl: text("source_url"),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("documents_org_hash_key").on(t.orgId, t.contentHash),
    index("documents_org_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * One retrievable span. `ordinal` is the `#chunk-N` anchor a citation carries,
 * and the offsets are what let the document page highlight the quoted span in
 * its surrounding context — which is what makes the citation reviewable rather
 * than merely resolvable.
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: bigint("document_id", { mode: "number" })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    body: text("body").notNull(),
    /** Set when the chunk is a single speaker's turn in a transcript. */
    speaker: text("speaker"),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    /** bge-small-en, computed on the worker. See apps/api/src/embed.ts */
    embedding: vector("embedding", { dimensions: 384 }),
  },
  (t) => [
    unique("document_chunks_doc_ordinal_key").on(t.documentId, t.ordinal),
    index("document_chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("document_chunks_org_idx").on(t.orgId),
  ],
);

/* ------------------------------------------------------- change history */

/**
 * The change log, and the checkpoints that bound it.
 *
 * The graph says what depends on what. This says *what happened, when* — and
 * the two are deliberately different stores. Commits are events: high volume,
 * append-only, and every question asked of them is a time range. Modelling
 * them as graph nodes would put a million rows into a table whose every query
 * is a six-hop traversal, to answer a question that is really a btree scan.
 *
 * The pair exists so an investigation can start with the smallest window that
 * could contain the cause — last known-good checkpoint to incident — and widen
 * only when that window comes up empty.
 */

export const changeKind = pgEnum("change_kind", ["commit", "pull_request"]);

export const repositories = pgTable(
  "repositories",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Which installation may read it. Null while only a shared token is set. */
    installationId: bigint("installation_id", { mode: "number" }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("repositories_org_full_name_key").on(t.orgId, t.owner, t.name)],
);

/**
 * One row per commit and per pull request, in one table rather than two.
 *
 * Every read is "what changed between these two instants", and that question
 * does not care which kind it was — splitting them would make the primary
 * query a union and cost the index that makes it fast.
 */
export const changes = pgTable(
  "changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: changeKind("kind").notNull(),
    /** Commit SHA, or the pull request number as text. */
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    /** Commit body or PR description. Rationale in its own right, so it is kept. */
    body: text("body"),
    authorLogin: text("author_login"),
    authorEmail: text("author_email"),
    /**
     * When the change happened at GitHub, never when Sadhak saw it. A backfill
     * running days later would otherwise shift every window by its own lag,
     * and the window is the entire point.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Redelivery and an overlapping backfill must converge, not duplicate.
    unique("changes_repo_kind_external_key").on(t.repoId, t.kind, t.externalId),
    // The one index the whole feature rests on: a range scan per repo.
    index("changes_repo_time_idx").on(t.repoId, t.occurredAt),
    index("changes_org_time_idx").on(t.orgId, t.occurredAt),
  ],
);

/**
 * The files a change touched. This is what later lets a change be judged
 * relevant to a particular service rather than merely to a repository — in a
 * monorepo, without paths every change looks equally implicated in everything.
 *
 * Paths only. Diffs are source code, and storing them would trade away the
 * promise that Sadhak reads structure rather than contents; the citation links
 * to GitHub, which already renders the diff better than we would.
 */
export const changePaths = pgTable(
  "change_paths",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    changeId: bigint("change_id", { mode: "number" })
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    status: text("status").notNull().default("modified"),
  },
  (t) => [
    unique("change_paths_change_path_key").on(t.changeId, t.path),
    index("change_paths_path_idx").on(t.path),
  ],
);

/**
 * The durable watermark, which the codebase otherwise has nowhere.
 *
 * Every other paginated crawl holds its cursor in a local variable and
 * discards it on return, so a failure restarts from the beginning and a
 * partial run leaves no record of how far it got. Committing this per page is
 * what makes a backfill resumable rather than merely repeatable.
 */
export const repoCursors = pgTable(
  "repo_cursors",
  {
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: changeKind("kind").notNull(),
    /** Oldest instant walked back to so far. Null before the first page. */
    backfilledTo: timestamp("backfilled_to", { withTimezone: true }),
    /** Newest instant seen, so an incremental pass knows where to resume. */
    caughtUpTo: timestamp("caught_up_to", { withTimezone: true }),
    /**
     * How many pages of an index-paged list have been walked.
     *
     * Pull requests need this because GitHub's list endpoint has no `until` to
     * narrow, so the only way to resume is by page number. Without it the walk
     * restarts at page one on every run and can never reach the tail.
     */
    pagesWalked: integer("pages_walked").notNull().default(0),
    /**
     * How far down an in-progress forward drain has reached.
     *
     * A catch-up walks newest-first from the newest commit down towards
     * `caughtUpTo`, so until it reaches the bottom it holds "everything above
     * X", which `caughtUpTo` — meaning "everything below Y" — cannot express.
     * Advancing the watermark on a partial drain would jump it over the part
     * not yet fetched. This is the resume point instead; null means no drain
     * is in flight.
     */
    drainingTo: timestamp("draining_to", { withTimezone: true }),
    /** Set when history is exhausted, so the job stops asking. */
    complete: boolean("complete").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.kind] })],
);

/**
 * A moment the system is believed to have been healthy.
 *
 * Confidence is explicit and varies by kind because these are not equally
 * trustworthy: a human ticking "deployed and verified" is a stronger claim
 * than a crawl that merely completed without error. The investigation starts
 * at the most recent, most trusted checkpoint before the incident and walks
 * backwards, so a wrong confidence costs a wasted round rather than a wrong
 * answer.
 */
export const checkpointKind = pgEnum("checkpoint_kind", [
  "manual",
  "gate_approved",
  "crawl_healthy",
  "incident_recovered",
  "release",
]);

export const checkpoints = pgTable(
  "checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: checkpointKind("kind").notNull(),
    /** Narrows the window when set; a null scope is org-wide. */
    repoId: bigint("repo_id", { mode: "number" }).references(() => repositories.id, {
      onDelete: "cascade",
    }),
    nodeId: bigint("node_id", { mode: "number" }).references(() => nodes.id, {
      onDelete: "cascade",
    }),
    environment: text("environment"),
    label: text("label").notNull(),
    /** How much this point is trusted as known-good. 0..1. */
    confidence: real("confidence").notNull().default(0.5),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** What made this a checkpoint, so the claim is inspectable. */
    sourceUrl: text("source_url"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checkpoints_org_time_idx").on(t.orgId, t.occurredAt),
    index("checkpoints_repo_time_idx").on(t.repoId, t.occurredAt),
  ],
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
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    agent: text("agent").notNull(),
    step: bigint("step", { mode: "number" }).notNull(),
    tool: text("tool").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_traces_run_idx").on(t.runId, t.step),
    index("agent_traces_org_time_idx").on(t.orgId, t.createdAt),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Nullable: system jobs (retention) belong to no org. */
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    state: jobState("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    priority: smallint("priority").notNull().default(0),
    lastError: text("last_error"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** Idempotent enqueue: unique among queued/running rows. */
    dedupeKey: text("dedupe_key"),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("jobs_claim_idx").on(t.state, t.runAfter, t.priority)],
);

/* -------------------------------------------------- cartographer (plan 6) */

export const crawls = pgTable(
  "crawls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectorInstanceId: bigint("connector_instance_id", { mode: "number" })
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("full"), // 'full' | 'incremental'
    state: crawlState("state").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
    error: text("error"),
  },
  (t) => [index("crawls_org_started_idx").on(t.orgId, t.startedAt)],
);

/** Append-only: corrections are the moat data, so they are never edited. */
export const criticalityOverrides = pgTable(
  "criticality_overrides",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    nodeId: bigint("node_id", { mode: "number" })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    oldValue: real("old_value").notNull(),
    newValue: real("new_value").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("criticality_overrides_node_idx").on(t.nodeId, t.createdAt)],
);

/** A cross-connector reference we refused to guess at. Reviewer's inbox. */
export const unresolvedRefs = pgTable(
  "unresolved_refs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    crawlId: bigint("crawl_id", { mode: "number" }).references(() => crawls.id, {
      onDelete: "cascade",
    }),
    /**
     * Which instance's crawl produced this set.
     *
     * These rows are the *current* unresolved references, replaced wholesale
     * on each crawl rather than appended to, so the replace has to be scoped
     * to the connector that owns them — otherwise one connector's crawl would
     * clear another's findings.
     */
    connectorInstanceId: bigint("connector_instance_id", { mode: "number" }).references(
      () => connectorInstances.id,
      { onDelete: "cascade" },
    ),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    candidates: jsonb("candidates").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("unresolved_refs_org_idx").on(t.orgId, t.createdAt),
    index("unresolved_refs_instance_idx").on(t.connectorInstanceId),
  ],
);

/* ----------------------------------------------------- sentinel (plan 7) */

/**
 * The single persistence point for every verdict computation in the system —
 * direct service calls, all three enforcement modes, and backtest replays
 * alike. `impacted` and `evidence` are frozen snapshots on purpose: the graph
 * mutates daily, and an auditable decision must carry the evidence *as it
 * stood*, not a pointer into a graph that has since moved.
 */
export const verdicts = pgTable(
  "verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    change: jsonb("change").$type<Record<string, unknown>>().notNull(),
    verdict: text("verdict").notNull(),
    impacted: jsonb("impacted").$type<BlastRow[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<Evidence[]>().notNull().default([]),
    graphVersion: bigint("graph_version", { mode: "number" }).notNull().default(0),
    computedInMs: integer("computed_in_ms").notNull().default(0),
    explanation: text("explanation"),
    explanationState: text("explanation_state").notNull().default("pending"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verdicts_org_time_idx").on(t.orgId, t.createdAt)],
);

/** Bumped by triggers on edge writes and criticality overrides. */
export const graphVersions = pgTable("graph_versions", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull().default(0),
});

/* --------------------------------------------------- enforcement (plan 8) */

/**
 * Not one column here duplicates the verdict. Change, evidence, impacted and
 * timing live exactly once, on the `verdicts` row. This table answers a
 * different question: under which enforcement mode, for which actor and key,
 * and was it real or a simulation.
 */
export const gateDecisions = pgTable(
  "gate_decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    verdictId: uuid("verdict_id")
      .notNull()
      .references(() => verdicts.id, { onDelete: "cascade" }),
    mode: gateMode("mode").notNull(),
    /** Simulations are recorded and flagged; metrics filter on this column. */
    dryRun: boolean("dry_run").notNull().default(false),
    actor: text("actor"),
    apiKeyId: bigint("api_key_id", { mode: "number" }).references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executionResult: jsonb("execution_result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gate_decisions_org_time_idx").on(t.orgId, t.createdAt, t.id),
    unique("gate_decisions_idem").on(t.apiKeyId, t.idempotencyKey),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "cascade",
    }),
    accountLogin: text("account_login"),
    repositorySelection: text("repository_selection"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("github_installations_org_idx").on(t.orgId)],
);

/* -------------------------------------------------------- reflex (plan 9) */

/**
 * One row per detected change. Created at detection, carrying the frozen
 * verdict evidence, accumulating timestamps as the incident moves. This table
 * *is* the MTTD/MTTR dataset — this plan records, Plan 11 computes. No MTTD
 * or MTTR number is asserted anywhere in product copy from here.
 */
export const reflexIncidents = pgTable(
  "reflex_incidents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** sha256(connector:externalId:operation:vendorEventId) — at-least-once dedupe. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    connector: text("connector").notNull(),
    target: text("target").notNull(),
    operation: text("operation").notNull(),
    externalId: text("external_id").notNull(),
    nodeId: bigint("node_id", { mode: "number" }).references(() => nodes.id, {
      onDelete: "set null",
    }),
    actor: jsonb("actor").$type<{
      name?: string;
      email?: string;
      vendorUserId?: string;
    }>(),
    verdict: text("verdict"),
    verdictId: uuid("verdict_id").references(() => verdicts.id, { onDelete: "set null" }),
    blast: jsonb("blast").$type<BlastRow[]>(),
    evidence: jsonb("evidence").$type<Evidence[]>(),
    /** 'push' | 'poll' — Plan 11 must never blend the two into one latency. */
    detectPath: text("detect_path").notNull().default("push"),
    slackChannel: text("slack_channel"),
    slackTs: text("slack_ts"),
    /** The vendor's clock. MTTD across clocks is approximate; say so. */
    changeAt: timestamp("change_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    verdictAt: timestamp("verdict_at", { withTimezone: true }),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    revertRequestedAt: timestamp("revert_requested_at", { withTimezone: true }),
    revertRequestedBy: text("revert_requested_by"),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    revertError: text("revert_error"),
    state: incidentState("state").notNull().default("detected"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reflex_incidents_org_state_idx").on(t.orgId, t.state, t.createdAt)],
);

/**
 * The revert source of truth. Structure only — workflow JSON references
 * credential *ids*, never secret values, and no row data ever lands here.
 */
export const structureSnapshots = pgTable(
  "structure_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    externalId: text("external_id").notNull(),
    contentHash: text("content_hash").notNull(),
    structure: jsonb("structure").$type<Record<string, unknown>>().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("structure_snapshots_identity").on(
      t.orgId,
      t.connector,
      t.externalId,
      t.contentHash,
    ),
    index("structure_snapshots_lookup_idx").on(t.orgId, t.externalId, t.capturedAt),
  ],
);

export const reflexSettings = pgTable("reflex_settings", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  slackChannelId: text("slack_channel_id"),
  /** APPROVE incidents are recorded silently — a ping per green change is how Reflex gets muted. */
  alertThreshold: text("alert_threshold").notNull().default("WARN"),
  dmActor: boolean("dm_actor").notNull().default(true),
});

/* ----------------------------------------------------- historian (plan 10) */

/** An org with zero scopes mines nothing. No tool parameter can widen this. */
export const miningScopes = pgTable(
  "mining_scopes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    scopeValue: text("scope_value").notNull(),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("mining_scopes_identity").on(t.orgId, t.connector, t.scopeValue)],
);

export const historianRuns = pgTable(
  "historian_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subjectNodeId: bigint("subject_node_id", { mode: "number" }).references(
      () => nodes.id,
      {
        onDelete: "set null",
      },
    ),
    state: historianRunState("state").notNull().default("queued"),
    edgesTotal: integer("edges_total").notNull().default(0),
    edgesProposed: integer("edges_proposed").notNull().default(0),
    edgesGaveUp: integer("edges_gave_up").notNull().default(0),
    edgesSkippedQuota: integer("edges_skipped_quota").notNull().default(0),
    requestBudget: integer("request_budget").notNull().default(0),
    requestsUsed: integer("requests_used").notNull().default(0),
    startedBy: text("started_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("historian_runs_org_idx").on(t.orgId, t.createdAt)],
);

export const historianRunEdges = pgTable(
  "historian_run_edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => historianRuns.id, { onDelete: "cascade" }),
    edgeId: bigint("edge_id", { mode: "number" })
      .notNull()
      .references(() => edges.id, { onDelete: "cascade" }),
    /** = agent_traces.run_id for this edge's loop. */
    loopRunId: text("loop_run_id"),
    outcome: text("outcome"),
  },
  (t) => [
    unique("historian_run_edges_identity").on(t.runId, t.edgeId),
    index("historian_run_edges_loop_idx").on(t.loopRunId),
  ],
);

/** Monthly spend attribution. On free slugs the dollar figure is 0.0000. */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    month: date("month").notNull(),
    agent: text("agent").notNull(),
    tier: text("tier").notNull(),
    requests: integer("requests").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
  },
  (t) => [unique("llm_usage_identity").on(t.orgId, t.month, t.agent, t.tier)],
);

/**
 * The daily-cap ledger, at the grain the cap actually has. One OpenRouter key
 * serves every org, so remaining-today is an *account* number: the cap minus
 * the sum across all orgs. A per-org budget inside a shared ceiling is an
 * allocation, not a guarantee.
 */
export const llmRequests = pgTable(
  "llm_requests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    day: date("day").notNull(),
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "cascade",
    }),
    agent: text("agent").notNull(),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [unique("llm_requests_identity").on(t.day, t.orgId, t.agent)],
);

/**
 * Fixed-window rate counters. Shared across replicas because a per-key or
 * per-org budget that each replica counted separately would be N times the
 * number written in the docs.
 *
 * The table is `UNLOGGED` (see the migration): counters are worth less than
 * the WAL churn of persisting them, and losing a window to a crash costs one
 * minute of over-permissive limiting, never correctness. The per-IP tier
 * deliberately does *not* live here — it protects a single replica from
 * unauthenticated floods and must cost zero round trips.
 */
export const rateCounters = pgTable(
  "rate_counters",
  {
    /** "{tier}:{id}" — e.g. "key:412", "org:7", "webhook:3". */
    bucket: text("bucket").notNull(),
    /** floor(now, window) — the window this count belongs to. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);

/* ---------------------------------------------------------- reviewer */

/**
 * Two-level hashes per connector instance: one `root` row answering "did
 * anything change here" in a single comparison, and one row per entity scope
 * turning a yes into "exactly these things".
 */
export const structuralHashes = pgTable(
  "structural_hashes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectorInstanceId: bigint("connector_instance_id", { mode: "number" })
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    /** 'root', or an entity scope like 'workflow/17', 'base/appX'. */
    scope: text("scope").notNull(),
    /** sha256 hex over the canonical form — see reviewer/hash.ts. */
    hash: text("hash").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("structural_hashes_identity").on(t.orgId, t.connectorInstanceId, t.scope),
  ],
);

/**
 * The correction queue. Three sources land here — hash changes, staleness
 * events and unresolved references — because an operator should review "what
 * does the map have wrong" in one place rather than three.
 */
export const driftFindings = pgTable(
  "drift_findings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectorInstanceId: bigint("connector_instance_id", { mode: "number" })
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    kind: driftKind("kind").notNull(),
    scope: text("scope").notNull(),
    /** Stable digest of scope + change shape. The suppression key. */
    signature: text("signature").notNull(),
    /** What the map believed, captured before the reconciling crawl runs. */
    documentedState: jsonb("documented_state").$type<Record<string, unknown>>(),
    liveState: jsonb("live_state").$type<Record<string, unknown>>(),
    state: findingState("state").notNull().default("open"),
    /** Judgment only. A resource limit is never a reason to dismiss. */
    dismissReason: text("dismiss_reason"),
    /**
     * Who judged it: a user identifier, or `reviewer` for the triage agent.
     *
     * Load-bearing, not provenance decoration. Only a *human* dismissal earns
     * suppression. The triage agent reads table and column names that come
     * from a customer's systems, so its prompt carries attacker-influenceable
     * text; if an agent dismissal could mute a signature, a hostile field name
     * would be a way to silence a real breakage for 30 days. The mute is
     * therefore gated on this column rather than on the model resisting
     * injection.
     */
    dismissedBy: text("dismissed_by"),
    /**
     * Stamped when a run ended on a step or token limit rather than on a
     * judgment. The state stays `open`, so an investigation that never
     * finished cannot mute the signature it failed to reach a verdict on.
     */
    budgetExhaustedAt: timestamp("budget_exhausted_at", { withTimezone: true }),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("drift_findings_org_state_idx").on(t.orgId, t.state),
    index("drift_findings_signature_idx").on(t.orgId, t.signature),
  ],
);

/**
 * Daily metric snapshots, so a series survives the events that produced it
 * being pruned — and so a dashboard reads one row per day rather than
 * re-aggregating every incident on every page load.
 *
 * Recomputed idempotently over a trailing window rather than appended: every
 * input is an immutable event table, so a late-arriving webhook self-heals on
 * the next run instead of leaving a permanently wrong day.
 */
export const metricRollups = pgTable(
  "metric_rollups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** UTC date. Local days would shift the series when a customer travels. */
    day: date("day").notNull(),
    metric: text("metric").notNull(),
    value: numeric("value").notNull(),
    /** p95 beside a median, sample counts — whatever the metric needs. */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("metric_rollups_identity").on(t.orgId, t.day, t.metric)],
);

/* ------------------------------------------------------- inferred types */

/** The persisted row. `Verdict` in types.ts is the APPROVE|WARN|BLOCK union. */
export type VerdictRow = typeof verdicts.$inferSelect;
export type GateDecision = typeof gateDecisions.$inferSelect;
export type ReflexIncident = typeof reflexIncidents.$inferSelect;
export type StructureSnapshot = typeof structureSnapshots.$inferSelect;
export type MiningScope = typeof miningScopes.$inferSelect;
export type HistorianRun = typeof historianRuns.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Member = typeof members.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type ConnectorInstance = typeof connectorInstances.$inferSelect;
export type ConnectorCredential = typeof connectorCredentials.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type Edge = typeof edges.$inferSelect;
export type NewEdge = typeof edges.$inferInsert;
export type Rationale = typeof rationale.$inferSelect;
export type NewRationale = typeof rationale.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentChunk = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Change = typeof changes.$inferSelect;
export type NewChange = typeof changes.$inferInsert;
export type ChangePath = typeof changePaths.$inferSelect;
export type Checkpoint = typeof checkpoints.$inferSelect;
export type NewCheckpoint = typeof checkpoints.$inferInsert;
export type AgentTrace = typeof agentTraces.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Crawl = typeof crawls.$inferSelect;
export type StructuralHash = typeof structuralHashes.$inferSelect;
export type DriftFinding = typeof driftFindings.$inferSelect;
export type MetricRollup = typeof metricRollups.$inferSelect;
export type NewDriftFinding = typeof driftFindings.$inferInsert;

/* ------------------------------------------------------------------ email */

/**
 * Opt-outs, stored as presence rather than as a boolean.
 *
 * A row means "this person does not want this category". No row means they do,
 * which is also the state of every user who has never thought about it — so the
 * default requires no backfill and cannot be got wrong by a missing migration.
 */
export const emailPreferences = pgTable(
  "email_preferences",
  {
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: emailCategory("category").notNull(),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category] })],
);

/**
 * Every send, recorded. Two reasons, and the second is the one that matters:
 * it answers "did we actually email them" during a support conversation, and
 * it is the evidence that an opted-out person stopped receiving things.
 */
export const emailLog = pgTable(
  "email_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "cascade",
    }),
    category: emailCategory("category").notNull(),
    template: text("template").notNull(),
    to: text("to").notNull(),
    providerMessageId: text("provider_message_id"),
    /** Null when a provider is configured and it went out. */
    skippedReason: text("skipped_reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_log_org_template_idx").on(t.orgId, t.template, t.sentAt)],
);

/* ------------------------------------------------- post-merge CI (plan 12) */

/**
 * A CI run that failed after a merge, and what Sadhak worked out about it.
 *
 * The row exists from the moment the webhook lands, before any analysis, so a
 * failure is never lost because the model was down or the logs were slow. The
 * `state` column is the honest record of how far it got: a `captured` row with
 * an error is a failure nobody was told about, which is worth being able to
 * query for.
 *
 * Keyed on (runId, runAttempt) rather than runId alone. Re-running a failed
 * job is the first thing anyone does, and each attempt is a distinct event with
 * its own logs — deduping them together would silently analyse the first
 * attempt and ignore the one the developer is actually looking at.
 */
export const ciFailures = pgTable(
  "ci_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),

    /** GitHub's identifiers, so a row can be traced back to the run it describes. */
    runId: bigint("run_id", { mode: "number" }).notNull(),
    runAttempt: integer("run_attempt").notNull().default(1),
    headSha: text("head_sha").notNull(),
    branch: text("branch").notNull(),
    workflowName: text("workflow_name").notNull(),
    htmlUrl: text("html_url").notNull(),
    /** The merge that caused it, when the run reports one. */
    prNumber: integer("pr_number"),

    /** Which job and step failed. Null until the logs have been read. */
    jobName: text("job_name"),
    stepName: text("step_name"),

    /**
     * The part of the log worth reading, not the log. Actions logs run to
     * megabytes and almost all of it is setup noise; storing the whole thing
     * would cost more than it explains and would not fit a model's context.
     */
    failureExcerpt: text("failure_excerpt"),

    /**
     * The excerpt with run-specific noise stripped — paths, hashes, timings —
     * so two occurrences of the same underlying break compare equal. This is
     * what "have we seen this before" is asked against.
     */
    signature: text("signature"),

    /** The model's reasoning: cause, recommendation, evidence, confidence. */
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),

    /** captured -> analysed -> alerted. `failed` records why it stopped. */
    state: text("state").notNull().default("captured"),
    lastError: text("last_error"),

    slackChannelId: text("slack_channel_id"),
    slackTs: text("slack_ts"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    analysedAt: timestamp("analysed_at", { withTimezone: true }),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
  },
  (t) => [
    unique("ci_failures_run_attempt_key").on(t.orgId, t.runId, t.runAttempt),
    index("ci_failures_org_created_idx").on(t.orgId, t.createdAt),
    // Precedent lookup: "this org, this signature, before now".
    index("ci_failures_signature_idx").on(t.orgId, t.signature),
  ],
);

/**
 * Which model produced the vectors currently in the database.
 *
 * One row, ever. It exists so that changing EMBEDDING_PROVIDER is a safe
 * operation rather than a silent corruption: two embedding models do not share
 * a vector space even when they agree on width, so a query embedded by one and
 * compared against chunks embedded by the other returns nonsense. Nothing
 * errors — the lexical half of retrieval keeps working and the ranking merely
 * gets worse, which is close to undetectable.
 *
 * On boot the API compares this against the configured model and, on a change,
 * clears the vectors so the embed job recomputes them.
 */
export const embeddingState = pgTable("embedding_state", {
  /** Always 1. The check constraint is what makes "one row, ever" true. */
  id: integer("id").primaryKey().default(1),
  model: text("model").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
