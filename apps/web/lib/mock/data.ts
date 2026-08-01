/**
 * The mock world every /app screen renders until the real API lands. One
 * dataset, shaped like the shared contracts, seeded with the demo_billing
 * story the whole plan set demos against: deleting invoices.vat_rate must
 * BLOCK because eu_vat_report depends on it, and only Marcus — who left —
 * ever explained why.
 */

export type NodeKind =
  | "table"
  | "field"
  | "view"
  | "workflow"
  | "step"
  | "base"
  | "channel"
  | "person"
  | "credential";

export type Connector = "postgres" | "n8n" | "airtable" | "slack" | "github";

export type Provenance = "static_parse" | "runtime_observed" | "llm_inferred";

export interface GraphNode {
  id: number;
  name: string;
  kind: NodeKind;
  connector: Connector;
  externalId: string;
  /** Canonical stops: 1.0 / 0.7 / 0.4 / 0.1 */
  criticality: number;
  lastSeen: string;
  /** Number of distinct people whose confirmed rationale explains this node's edges. 0 = unexplained. */
  busFactor: number;
  owner?: string;
  /** Precomputed layout position (the real app runs d3-force in a worker). */
  x: number;
  y: number;
}

export interface GraphEdge {
  id: number;
  /** Changing `source` ripples to `target`. */
  source: number;
  target: number;
  kind:
    | "feeds"
    | "reads"
    | "writes"
    | "renders"
    | "notifies"
    | "authenticates"
    | "contains";
  provenance: Provenance;
  confidence: number;
  /** True when a confirmed rationale explains this edge. */
  explained: boolean;
}

export const NODES: GraphNode[] = [
  // Postgres — demo_billing
  {
    id: 1,
    name: "customers",
    kind: "table",
    connector: "postgres",
    externalId: "demo_billing.public.customers",
    criticality: 0.7,
    lastSeen: "2026-07-22T09:14:00Z",
    busFactor: 2,
    x: 130,
    y: 210,
  },
  {
    id: 2,
    name: "invoices",
    kind: "table",
    connector: "postgres",
    externalId: "demo_billing.public.invoices",
    criticality: 1.0,
    lastSeen: "2026-07-22T09:14:00Z",
    busFactor: 2,
    x: 130,
    y: 360,
  },
  {
    id: 3,
    name: "invoices.vat_rate",
    kind: "field",
    connector: "postgres",
    externalId: "demo_billing.public.invoices.vat_rate",
    criticality: 1.0,
    lastSeen: "2026-07-22T09:14:00Z",
    busFactor: 1,
    owner: "Marcus Chen",
    x: 250,
    y: 430,
  },
  {
    id: 4,
    name: "invoices.amount",
    kind: "field",
    connector: "postgres",
    externalId: "demo_billing.public.invoices.amount",
    criticality: 0.7,
    lastSeen: "2026-07-22T09:14:00Z",
    busFactor: 0,
    x: 250,
    y: 320,
  },
  {
    id: 5,
    name: "customers.email",
    kind: "field",
    connector: "postgres",
    externalId: "demo_billing.public.customers.email",
    criticality: 0.4,
    lastSeen: "2026-07-22T09:14:00Z",
    busFactor: 0,
    x: 250,
    y: 150,
  },
  {
    id: 6,
    name: "eu_vat_report",
    kind: "view",
    connector: "postgres",
    externalId: "demo_billing.public.eu_vat_report",
    criticality: 1.0,
    lastSeen: "2026-07-22T09:14:00Z",
    busFactor: 1,
    owner: "Marcus Chen",
    x: 420,
    y: 480,
  },
  {
    id: 24,
    name: "pg-readonly",
    kind: "credential",
    connector: "postgres",
    externalId: "cred_pg_ro_01",
    criticality: 0.7,
    lastSeen: "2026-07-22T09:14:00Z",
    busFactor: 2,
    x: 130,
    y: 520,
  },

  // n8n — three workflows
  {
    id: 7,
    name: "billing-sync",
    kind: "workflow",
    connector: "n8n",
    externalId: "n8n.wf.billing-sync",
    criticality: 0.7,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 2,
    x: 540,
    y: 220,
  },
  {
    id: 8,
    name: "fetch-invoices",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.billing-sync.fetch",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 0,
    x: 450,
    y: 160,
  },
  {
    id: 9,
    name: "transform-vat",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.billing-sync.transform",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 1,
    owner: "Marcus Chen",
    x: 560,
    y: 120,
  },
  {
    id: 10,
    name: "upsert-airtable",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.billing-sync.upsert",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 2,
    x: 670,
    y: 160,
  },
  {
    id: 11,
    name: "vat-report-mailer",
    kind: "workflow",
    connector: "n8n",
    externalId: "n8n.wf.vat-report-mailer",
    criticality: 1.0,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 1,
    owner: "Marcus Chen",
    x: 620,
    y: 480,
  },
  {
    id: 12,
    name: "query-eu-vat-report",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.vat-mailer.query",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 1,
    owner: "Marcus Chen",
    x: 545,
    y: 545,
  },
  {
    id: 13,
    name: "render-pdf",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.vat-mailer.render",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 0,
    x: 665,
    y: 575,
  },
  {
    id: 14,
    name: "email-finance",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.vat-mailer.email",
    criticality: 0.7,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 0,
    x: 780,
    y: 540,
  },
  {
    id: 15,
    name: "dunning-reminders",
    kind: "workflow",
    connector: "n8n",
    externalId: "n8n.wf.dunning",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 2,
    x: 800,
    y: 300,
  },
  {
    id: 16,
    name: "find-overdue",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.dunning.find",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 0,
    x: 730,
    y: 245,
  },
  {
    id: 17,
    name: "notify-slack",
    kind: "step",
    connector: "n8n",
    externalId: "n8n.wf.dunning.notify",
    criticality: 0.4,
    lastSeen: "2026-07-22T08:40:00Z",
    busFactor: 2,
    x: 880,
    y: 245,
  },

  // Airtable — Finance Ops
  {
    id: 18,
    name: "Finance Ops",
    kind: "base",
    connector: "airtable",
    externalId: "appFinanceOps01",
    criticality: 0.4,
    lastSeen: "2026-07-21T22:05:00Z",
    busFactor: 2,
    x: 890,
    y: 90,
  },
  {
    id: 19,
    name: "Invoices Mirror",
    kind: "table",
    connector: "airtable",
    externalId: "appFinanceOps01.tblInvMirror",
    criticality: 0.7,
    lastSeen: "2026-07-21T22:05:00Z",
    busFactor: 2,
    x: 800,
    y: 140,
  },
  {
    id: 20,
    name: "VAT amount",
    kind: "field",
    connector: "airtable",
    externalId: "appFinanceOps01.tblInvMirror.fldVat",
    criticality: 0.7,
    lastSeen: "2026-07-21T22:05:00Z",
    busFactor: 0,
    x: 920,
    y: 175,
  },

  // Slack
  {
    id: 21,
    name: "#finance-alerts",
    kind: "channel",
    connector: "slack",
    externalId: "C04FINALERTS",
    criticality: 0.4,
    lastSeen: "2026-07-22T07:55:00Z",
    busFactor: 2,
    x: 990,
    y: 330,
  },

  // People
  {
    id: 22,
    name: "Marcus Chen",
    kind: "person",
    connector: "slack",
    externalId: "U02MARCUS",
    criticality: 0.1,
    lastSeen: "2026-03-31T17:00:00Z",
    busFactor: 0,
    x: 380,
    y: 620,
  },
  {
    id: 23,
    name: "Priya Sharma",
    kind: "person",
    connector: "slack",
    externalId: "U01PRIYA",
    criticality: 0.1,
    lastSeen: "2026-07-22T07:55:00Z",
    busFactor: 0,
    x: 220,
    y: 620,
  },
];

export const EDGES: GraphEdge[] = [
  {
    id: 1,
    source: 3,
    target: 6,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.95,
    explained: true,
  },
  {
    id: 2,
    source: 2,
    target: 6,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.95,
    explained: false,
  },
  {
    id: 3,
    source: 1,
    target: 6,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.9,
    explained: false,
  },
  {
    id: 4,
    source: 6,
    target: 12,
    kind: "reads",
    provenance: "runtime_observed",
    confidence: 0.85,
    explained: true,
  },
  {
    id: 5,
    source: 12,
    target: 13,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
  {
    id: 6,
    source: 13,
    target: 14,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
  {
    id: 7,
    source: 12,
    target: 11,
    kind: "contains",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
  {
    id: 8,
    source: 2,
    target: 8,
    kind: "reads",
    provenance: "runtime_observed",
    confidence: 0.85,
    explained: false,
  },
  {
    id: 9,
    source: 8,
    target: 9,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
  {
    id: 10,
    source: 9,
    target: 10,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
  {
    id: 11,
    source: 10,
    target: 19,
    kind: "writes",
    provenance: "runtime_observed",
    confidence: 0.9,
    explained: true,
  },
  {
    id: 12,
    source: 19,
    target: 20,
    kind: "contains",
    provenance: "static_parse",
    confidence: 0.95,
    explained: false,
  },
  {
    id: 13,
    source: 3,
    target: 9,
    kind: "feeds",
    provenance: "llm_inferred",
    confidence: 0.5,
    explained: false,
  },
  {
    id: 14,
    source: 4,
    target: 9,
    kind: "feeds",
    provenance: "llm_inferred",
    confidence: 0.5,
    explained: false,
  },
  {
    id: 15,
    source: 19,
    target: 16,
    kind: "reads",
    provenance: "runtime_observed",
    confidence: 0.8,
    explained: false,
  },
  {
    id: 16,
    source: 16,
    target: 17,
    kind: "feeds",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
  {
    id: 17,
    source: 17,
    target: 21,
    kind: "notifies",
    provenance: "static_parse",
    confidence: 0.95,
    explained: true,
  },
  {
    id: 18,
    source: 5,
    target: 16,
    kind: "reads",
    provenance: "llm_inferred",
    confidence: 0.5,
    explained: false,
  },
  {
    id: 19,
    source: 24,
    target: 7,
    kind: "authenticates",
    provenance: "static_parse",
    confidence: 0.9,
    explained: false,
  },
  {
    id: 20,
    source: 24,
    target: 11,
    kind: "authenticates",
    provenance: "static_parse",
    confidence: 0.9,
    explained: false,
  },
  {
    id: 21,
    source: 8,
    target: 7,
    kind: "contains",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
  {
    id: 22,
    source: 16,
    target: 15,
    kind: "contains",
    provenance: "static_parse",
    confidence: 0.98,
    explained: false,
  },
];

export const nodeById = (id: number) => NODES.find((n) => n.id === id)!;

/* ------------------------------------------------------------- rationale */

export interface Rationale {
  id: number;
  edgeId: number;
  state: "confirmed" | "drafted";
  body: string;
  author: string;
  sourceKind: "slack" | "github" | "notion" | "email";
  sourceUrl: string;
  minedBy?: "historian";
  confidence?: number;
  createdAt: string;
}

export const RATIONALE: Rationale[] = [
  {
    id: 1,
    edgeId: 1,
    state: "confirmed",
    body: "VAT rate has to come from the invoice row, not the customer default — Danish invoices issued after 2019 carry the row-level rate and the report is wrong without it.",
    author: "Marcus Chen",
    sourceKind: "slack",
    sourceUrl: "https://acme-ops.slack.com/archives/C04FINALERTS/p1711021845000200",
    createdAt: "2026-03-21T14:04:00Z",
  },
  {
    id: 2,
    edgeId: 4,
    state: "confirmed",
    body: "The mailer queries eu_vat_report instead of the raw tables so finance sees exactly what the auditors see. Do not point it at invoices directly.",
    author: "Marcus Chen",
    sourceKind: "github",
    sourceUrl: "https://github.com/acme-ops/automation/pull/218#discussion_r1402277",
    createdAt: "2026-02-11T10:30:00Z",
  },
  {
    id: 3,
    edgeId: 11,
    state: "confirmed",
    body: "The Airtable mirror exists because finance can't query Postgres. It is read-only for them; the sync owns every row.",
    author: "Priya Sharma",
    sourceKind: "notion",
    sourceUrl: "https://notion.so/acme/finance-ops-runbook#airtable-mirror",
    createdAt: "2026-05-02T09:12:00Z",
  },
  {
    id: 4,
    edgeId: 17,
    state: "confirmed",
    body: "#finance-alerts is actively monitored during EU close week — dunning pings land there so the collections rota sees them same-day.",
    author: "Priya Sharma",
    sourceKind: "slack",
    sourceUrl: "https://acme-ops.slack.com/archives/C04FINALERTS/p1717406220000400",
    createdAt: "2026-06-03T11:17:00Z",
  },
  // Drafts waiting in the queue
  {
    id: 5,
    edgeId: 2,
    state: "drafted",
    body: "eu_vat_report joins invoices for the taxable base; the view breaks if invoices loses the currency column.",
    author: "Marcus Chen",
    sourceKind: "slack",
    sourceUrl: "https://acme-ops.slack.com/archives/C04FINALERTS/p1710438912000100",
    minedBy: "historian",
    confidence: 0.82,
    createdAt: "2026-07-21T18:40:00Z",
  },
  {
    id: 6,
    edgeId: 3,
    state: "drafted",
    body: "customer country drives the VAT jurisdiction split in the report — that's why customers is joined at all.",
    author: "Marcus Chen",
    sourceKind: "slack",
    sourceUrl: "https://acme-ops.slack.com/archives/C04FINALERTS/p1710439410000300",
    minedBy: "historian",
    confidence: 0.74,
    createdAt: "2026-07-21T18:42:00Z",
  },
  {
    id: 7,
    edgeId: 8,
    state: "drafted",
    body: "billing-sync polls invoices every 15 minutes; anything slower and the Airtable mirror lags the morning finance stand-up.",
    author: "Priya Sharma",
    sourceKind: "slack",
    sourceUrl: "https://acme-ops.slack.com/archives/C04FINALERTS/p1712900112000500",
    minedBy: "historian",
    confidence: 0.68,
    createdAt: "2026-07-21T19:05:00Z",
  },
  {
    id: 8,
    edgeId: 15,
    state: "drafted",
    body: "dunning reads the mirror, not Postgres, so collections can tweak the overdue threshold themselves in Airtable.",
    author: "Elena Petrova",
    sourceKind: "email",
    sourceUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzGtwqXPqRs",
    minedBy: "historian",
    confidence: 0.61,
    createdAt: "2026-07-21T19:11:00Z",
  },
  {
    id: 9,
    edgeId: 5,
    state: "drafted",
    body: "render-pdf uses the query step's row order — the report is sorted in SQL on purpose, not in the template.",
    author: "Marcus Chen",
    sourceKind: "github",
    sourceUrl: "https://github.com/acme-ops/automation/pull/231#discussion_r1419904",
    minedBy: "historian",
    confidence: 0.77,
    createdAt: "2026-07-22T06:20:00Z",
  },
  {
    id: 10,
    edgeId: 16,
    state: "drafted",
    body: "overdue notices bundle per customer before pinging Slack — one message per customer per day, agreed with collections.",
    author: "Priya Sharma",
    sourceKind: "slack",
    sourceUrl: "https://acme-ops.slack.com/archives/C04FINALERTS/p1718011201000600",
    minedBy: "historian",
    confidence: 0.7,
    createdAt: "2026-07-22T06:24:00Z",
  },
];

/* ----------------------------------------------------------- corrections */

export interface Correction {
  id: number;
  nodeId: number;
  summary: string;
  documented: string;
  live: string;
  agentRunId: string;
  createdAt: string;
}

export const CORRECTIONS: Correction[] = [
  {
    id: 1,
    nodeId: 15,
    summary: "dunning-reminders schedule drifted",
    documented: "Runs hourly between 08:00–18:00 CET",
    live: "Cron changed to daily 09:00 CET on 2026-07-14",
    agentRunId: "run_rev_204",
    createdAt: "2026-07-20T08:10:00Z",
  },
  {
    id: 2,
    nodeId: 19,
    summary: "Airtable table renamed upstream",
    documented: "Table name: Invoices Mirror",
    live: "Renamed to 'Invoices (synced)' in Airtable on 2026-07-18",
    agentRunId: "run_rev_209",
    createdAt: "2026-07-21T07:44:00Z",
  },
  {
    id: 3,
    nodeId: 9,
    summary: "transform-vat gained a rounding branch",
    documented: "Single expression: amount * vat_rate",
    live: "New IF node rounds to 2dp for SEK invoices since 2026-07-19",
    agentRunId: "run_rev_211",
    createdAt: "2026-07-22T05:58:00Z",
  },
];

/* ---------------------------------------------------------------- agents */

export interface TraceStep {
  step: number;
  tool: string;
  args: string;
  result: string;
  elapsedMs: number;
}

export interface AgentRun {
  id: string;
  agent: "historian" | "reviewer";
  goal: string;
  outcome: "propose_rationale" | "draft_correction" | "give_up" | "dismiss" | "running";
  outcomeDetail: string;
  startedAt: string;
  durationMs: number;
  steps: TraceStep[];
}

export const AGENT_RUNS: AgentRun[] = [
  {
    id: "run_hist_318",
    agent: "historian",
    goal: "Explain edge invoices → eu_vat_report",
    outcome: "propose_rationale",
    outcomeDetail: "Draft queued for review (confidence 0.82)",
    startedAt: "2026-07-21T18:38:00Z",
    durationMs: 94000,
    steps: [
      {
        step: 1,
        tool: "get_edge_context",
        args: "{ edge: invoices → eu_vat_report }",
        result:
          "view SQL references invoices.amount, invoices.currency, invoices.vat_rate",
        elapsedMs: 320,
      },
      {
        step: 2,
        tool: "search_slack",
        args: '{ q: "eu_vat_report invoices", channel: #finance-alerts }',
        result: "3 threads, best match 2026-03-14 by Marcus Chen",
        elapsedMs: 2100,
      },
      {
        step: 3,
        tool: "fetch_thread",
        args: "{ ts: 1710438912.0001 }",
        result: 'quote: "eu_vat_report joins invoices for the taxable base…"',
        elapsedMs: 1800,
      },
      {
        step: 4,
        tool: "verify_span",
        args: "{ containment check against permalink }",
        result: "span found verbatim, whitespace-normalized",
        elapsedMs: 240,
      },
      {
        step: 5,
        tool: "propose_rationale",
        args: "{ edge, span, source_url }",
        result: "draft #5 created, state=drafted",
        elapsedMs: 180,
      },
    ],
  },
  {
    id: "run_hist_319",
    agent: "historian",
    goal: "Explain edge invoices.amount → transform-vat",
    outcome: "give_up",
    outcomeDetail:
      "No written trace found — inferred from runtime only; declining to guess",
    startedAt: "2026-07-21T19:20:00Z",
    durationMs: 132000,
    steps: [
      {
        step: 1,
        tool: "get_edge_context",
        args: "{ edge: invoices.amount → transform-vat }",
        result: "edge is llm_inferred (0.5); no static reference",
        elapsedMs: 300,
      },
      {
        step: 2,
        tool: "search_slack",
        args: '{ q: "transform-vat amount" }',
        result: "0 threads matched",
        elapsedMs: 2400,
      },
      {
        step: 3,
        tool: "search_github",
        args: '{ q: "transform-vat", repo: acme-ops/automation }',
        result: "2 PRs touch the step; neither mentions amount handling",
        elapsedMs: 3100,
      },
      {
        step: 4,
        tool: "search_slack",
        args: '{ q: "vat rounding billing-sync" }',
        result: "1 thread — discusses SEK rounding, not amount sourcing",
        elapsedMs: 2000,
      },
      {
        step: 5,
        tool: "give_up",
        args: '{ reason: "no written trace" }',
        result: "edge stays unexplained; recorded honestly",
        elapsedMs: 90,
      },
    ],
  },
  {
    id: "run_hist_321",
    agent: "historian",
    goal: "Explain edge Invoices Mirror → find-overdue",
    outcome: "propose_rationale",
    outcomeDetail: "Draft queued for review (confidence 0.61)",
    startedAt: "2026-07-21T19:08:00Z",
    durationMs: 87000,
    steps: [
      {
        step: 1,
        tool: "get_edge_context",
        args: "{ edge: Invoices Mirror → find-overdue }",
        result: "runtime_observed 0.8; dunning reads tblInvMirror",
        elapsedMs: 280,
      },
      {
        step: 2,
        tool: "search_email",
        args: '{ q: "dunning airtable threshold" }',
        result: "1 thread from Elena Petrova, 2026-04-02",
        elapsedMs: 2600,
      },
      {
        step: 3,
        tool: "verify_span",
        args: "{ containment check }",
        result: "span found verbatim",
        elapsedMs: 210,
      },
      {
        step: 4,
        tool: "propose_rationale",
        args: "{ edge, span, source_url }",
        result: "draft #8 created, state=drafted",
        elapsedMs: 150,
      },
    ],
  },
  {
    id: "run_rev_204",
    agent: "reviewer",
    goal: "Drift check: dunning-reminders subgraph (hash changed)",
    outcome: "draft_correction",
    outcomeDetail: "Schedule drift found; correction queued",
    startedAt: "2026-07-20T08:06:00Z",
    durationMs: 61000,
    steps: [
      {
        step: 1,
        tool: "diff_subgraph",
        args: "{ root: dunning-reminders }",
        result: "cron trigger changed: 0 8-18 * * * → 0 9 * * *",
        elapsedMs: 420,
      },
      {
        step: 2,
        tool: "get_rationale",
        args: "{ node: dunning-reminders }",
        result: "runbook documents hourly cadence",
        elapsedMs: 350,
      },
      {
        step: 3,
        tool: "draft_correction",
        args: "{ documented vs live }",
        result: "correction #1 queued for human review",
        elapsedMs: 130,
      },
    ],
  },
  {
    id: "run_rev_209",
    agent: "reviewer",
    goal: "Drift check: Airtable Finance Ops base (hash changed)",
    outcome: "draft_correction",
    outcomeDetail: "Table rename detected; correction queued",
    startedAt: "2026-07-21T07:40:00Z",
    durationMs: 54000,
    steps: [
      {
        step: 1,
        tool: "diff_subgraph",
        args: "{ root: Finance Ops }",
        result: "tblInvMirror name: 'Invoices Mirror' → 'Invoices (synced)'",
        elapsedMs: 380,
      },
      {
        step: 2,
        tool: "draft_correction",
        args: "{ rename }",
        result: "correction #2 queued for human review",
        elapsedMs: 120,
      },
    ],
  },
  {
    id: "run_rev_212",
    agent: "reviewer",
    goal: "Drift check: billing-sync subgraph (hash changed)",
    outcome: "dismiss",
    outcomeDetail: "Hash change was a re-crawl artifact; live state matches records",
    startedAt: "2026-07-22T06:02:00Z",
    durationMs: 47000,
    steps: [
      {
        step: 1,
        tool: "diff_subgraph",
        args: "{ root: billing-sync }",
        result: "node order changed in export; no semantic diff",
        elapsedMs: 400,
      },
      {
        step: 2,
        tool: "dismiss",
        args: '{ reason: "no semantic drift" }',
        result: "finding dismissed; hash re-pinned",
        elapsedMs: 90,
      },
    ],
  },
];

/* ------------------------------------------------------------- decisions */

export interface Decision {
  id: string;
  mode: "hard-gate" | "proxy-gate" | "mcp" | "reflex" | "simulation";
  verdict: "APPROVE" | "WARN" | "BLOCK";
  dryRun: boolean;
  actor: string;
  change: string;
  targetNodeId: number;
  computedInMs: number;
  at: string;
}

export const DECISIONS: Decision[] = [
  {
    id: "dec_1041",
    mode: "simulation",
    verdict: "BLOCK",
    dryRun: true,
    actor: "priya@acme.ops",
    change: "delete field invoices.vat_rate",
    targetNodeId: 3,
    computedInMs: 38,
    at: "2026-07-22T08:52:00Z",
  },
  {
    id: "dec_1040",
    mode: "hard-gate",
    verdict: "APPROVE",
    dryRun: false,
    actor: "github: acme-ops/automation#241",
    change: "rename step render-pdf",
    targetNodeId: 13,
    computedInMs: 22,
    at: "2026-07-22T08:31:00Z",
  },
  {
    id: "dec_1039",
    mode: "mcp",
    verdict: "BLOCK",
    dryRun: false,
    actor: "agent: claude-ops-bot",
    change: "delete view eu_vat_report",
    targetNodeId: 6,
    computedInMs: 41,
    at: "2026-07-22T07:58:00Z",
  },
  {
    id: "dec_1038",
    mode: "proxy-gate",
    verdict: "WARN",
    dryRun: false,
    actor: "api-key: deploy-bot",
    change: "disable workflow dunning-reminders",
    targetNodeId: 15,
    computedInMs: 35,
    at: "2026-07-21T16:44:00Z",
  },
  {
    id: "dec_1037",
    mode: "reflex",
    verdict: "WARN",
    dryRun: false,
    actor: "webhook: n8n",
    change: "modified workflow billing-sync",
    targetNodeId: 7,
    computedInMs: 29,
    at: "2026-07-21T14:02:00Z",
  },
  {
    id: "dec_1036",
    mode: "simulation",
    verdict: "WARN",
    dryRun: true,
    actor: "priya@acme.ops",
    change: "disable workflow billing-sync",
    targetNodeId: 7,
    computedInMs: 31,
    at: "2026-07-21T11:20:00Z",
  },
  {
    id: "dec_1035",
    mode: "hard-gate",
    verdict: "BLOCK",
    dryRun: false,
    actor: "github: acme-ops/automation#238",
    change: "retype field invoices.vat_rate → text",
    targetNodeId: 3,
    computedInMs: 44,
    at: "2026-07-20T15:37:00Z",
  },
  {
    id: "dec_1034",
    mode: "proxy-gate",
    verdict: "APPROVE",
    dryRun: false,
    actor: "api-key: deploy-bot",
    change: "rename field customers.email",
    targetNodeId: 5,
    computedInMs: 18,
    at: "2026-07-20T10:11:00Z",
  },
  {
    id: "dec_1033",
    mode: "reflex",
    verdict: "BLOCK",
    dryRun: false,
    actor: "webhook: airtable",
    change: "deleted field VAT amount (reverted)",
    targetNodeId: 20,
    computedInMs: 33,
    at: "2026-07-19T09:26:00Z",
  },
  {
    id: "dec_1032",
    mode: "simulation",
    verdict: "APPROVE",
    dryRun: true,
    actor: "elena@acme.ops",
    change: "rename channel #finance-alerts",
    targetNodeId: 21,
    computedInMs: 12,
    at: "2026-07-18T13:03:00Z",
  },
];

/* --------------------------------------------------------------- metrics */

export const METRICS = {
  blocked: 2,
  warned: 2,
  approved: 2, // enforced modes only; dry-runs excluded
  revertsExecuted: 3,
  mttdP50Ms: 4200,
  mttrP50Ms: 11300,
  coverageConfirmedPct: 18, // 4 of 22 edges
  confirmedCount: 4,
  draftCount: 6,
  edgeCount: 22,
  unexplainedCount: 12,
  atRiskNodes: 3,
  atRiskBand: "likely 1 person",
  atRiskConfidence: "low confidence",
  atRiskPeople: ["Marcus Chen"],
  backtestHitRate: 0.86,
  backtestRunId: "bt_2026-07-21_04",
  backtestInputHash: "sha256:9f31c2…e8ad",
  weeklyVerdicts: [3, 5, 2, 6, 4, 7, 6], // last 7 days, enforced modes
  weeklyReverts: [0, 1, 0, 0, 1, 0, 1],
  // Distributions over the 3 executed reverts — small numbers shown honestly.
  detectRevertDist: [
    { bucket: "<5s", detect: 2, revert: 0 },
    { bucket: "5–10s", detect: 1, revert: 1 },
    { bucket: "10–20s", detect: 0, revert: 2 },
    { bucket: ">20s", detect: 0, revert: 0 },
  ],
};

/* -------------------------------------------------------------- settings */

export interface ConnectorInstance {
  id: string;
  connector: Connector;
  label: string;
  status: "healthy" | "warning" | "error";
  statusDetail: string;
  lastCrawlAt: string;
  lastCrawlStats: string;
  scopes: string[];
}

export const CONNECTORS: ConnectorInstance[] = [
  {
    id: "conn_pg_01",
    connector: "postgres",
    label: "demo_billing (primary)",
    status: "healthy",
    statusDetail: "Crawled 14 minutes ago",
    lastCrawlAt: "2026-07-22T09:14:00Z",
    lastCrawlStats: "7 nodes · 9 edges · 1.8s",
    scopes: [
      "CONNECT (read-only role sadhak_ro)",
      "SELECT on information_schema",
      "SELECT on pg_catalog.pg_views",
    ],
  },
  {
    id: "conn_n8n_01",
    connector: "n8n",
    label: "n8n.acme.ops",
    status: "healthy",
    statusDetail: "Crawled 48 minutes ago",
    lastCrawlAt: "2026-07-22T08:40:00Z",
    lastCrawlStats: "11 nodes · 12 edges · 3.2s",
    scopes: [
      "GET /workflows (read-only API key)",
      "GET /executions (last 200, metadata only)",
    ],
  },
  {
    id: "conn_at_01",
    connector: "airtable",
    label: "Finance Ops workspace",
    status: "warning",
    statusDetail: "Token expires in 6 days",
    lastCrawlAt: "2026-07-21T22:05:00Z",
    lastCrawlStats: "3 nodes · 3 edges · 1.1s",
    scopes: [
      "schema.bases:read",
      "data.records:read (structure only — no cell payloads stored)",
    ],
  },
];

export interface Member {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: string;
}

export const MEMBERS: Member[] = [
  {
    id: "u_demo",
    name: "Demo User",
    email: "demo@sadhak.online",
    role: "owner",
    joinedAt: "2026-06-01T09:00:00Z",
  },
  {
    id: "u_priya",
    name: "Priya Sharma",
    email: "priya@acme.ops",
    role: "admin",
    joinedAt: "2026-06-03T10:12:00Z",
  },
  {
    id: "u_elena",
    name: "Elena Petrova",
    email: "elena@acme.ops",
    role: "member",
    joinedAt: "2026-06-18T15:40:00Z",
  },
];

export const PENDING_INVITES = [
  {
    id: "inv_1",
    email: "sam@acme.ops",
    role: "viewer" as const,
    expiresAt: "2026-07-27T00:00:00Z",
  },
];

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export const API_KEYS: ApiKey[] = [
  {
    id: "key_1",
    name: "deploy-bot",
    prefix: "sdk_live_9f2c…",
    scopes: ["gate:invoke", "graph:read"],
    createdBy: "Demo User",
    lastUsedAt: "2026-07-22T08:31:00Z",
    createdAt: "2026-06-20T11:00:00Z",
  },
  {
    id: "key_2",
    name: "ci-check",
    prefix: "sdk_live_41ab…",
    scopes: ["gate:invoke"],
    createdBy: "Priya Sharma",
    lastUsedAt: "2026-07-21T16:44:00Z",
    createdAt: "2026-07-01T09:30:00Z",
  },
];

export const SESSIONS = [
  {
    id: "sess_1",
    device: "This device — Safari on macOS",
    ip: "84.212.11.4",
    lastSeen: "now",
    current: true,
  },
  {
    id: "sess_2",
    device: "Chrome on Windows",
    ip: "84.212.11.9",
    lastSeen: "2026-07-21T19:44:00Z",
    current: false,
  },
];

export const AUDIT_LOG = [
  {
    id: 1,
    at: "2026-07-22T08:52:00Z",
    actor: "priya@acme.ops",
    action: "gate.simulate",
    detail: "delete invoices.vat_rate → BLOCK (dry-run)",
  },
  {
    id: 2,
    at: "2026-07-22T08:31:00Z",
    actor: "github-app",
    action: "gate.decide",
    detail: "PR #241 rename render-pdf → APPROVE",
  },
  {
    id: 3,
    at: "2026-07-22T07:58:00Z",
    actor: "claude-ops-bot",
    action: "gate.decide",
    detail: "MCP delete eu_vat_report → BLOCK",
  },
  {
    id: 4,
    at: "2026-07-22T06:24:00Z",
    actor: "historian",
    action: "rationale.draft",
    detail: "draft #10 for edge find-overdue → notify-slack",
  },
  {
    id: 5,
    at: "2026-07-21T22:05:00Z",
    actor: "system",
    action: "crawl.complete",
    detail: "airtable Finance Ops: 3 nodes, 3 edges",
  },
  {
    id: 6,
    at: "2026-07-21T19:44:00Z",
    actor: "demo@sadhak.online",
    action: "session.create",
    detail: "Chrome on Windows, 84.212.11.9",
  },
  {
    id: 7,
    at: "2026-07-21T16:44:00Z",
    actor: "deploy-bot",
    action: "gate.decide",
    detail: "disable dunning-reminders → WARN",
  },
  {
    id: 8,
    at: "2026-07-21T14:02:00Z",
    actor: "reflex",
    action: "reflex.alert",
    detail: "billing-sync modified → Slack alert sent",
  },
  {
    id: 9,
    at: "2026-07-20T15:37:00Z",
    actor: "github-app",
    action: "gate.decide",
    detail: "PR #238 retype vat_rate → BLOCK, merge disabled",
  },
  {
    id: 10,
    at: "2026-07-19T09:26:00Z",
    actor: "reflex",
    action: "reflex.revert",
    detail: "VAT amount field restored in Airtable (11.3s)",
  },
  {
    id: 11,
    at: "2026-07-19T09:26:00Z",
    actor: "system",
    action: "connector.crawl",
    detail: "post-revert re-crawl of Finance Ops",
  },
  {
    id: 12,
    at: "2026-07-18T13:03:00Z",
    actor: "elena@acme.ops",
    action: "gate.simulate",
    detail: "rename #finance-alerts → APPROVE (dry-run)",
  },
];

/** Marcus's sole-source edges — the departure fan-out worklist. */
export const DEPARTURE_EDGES = [
  { edgeId: 1, label: "invoices.vat_rate → eu_vat_report" },
  { edgeId: 4, label: "eu_vat_report → query-eu-vat-report" },
  { edgeId: 13, label: "invoices.vat_rate → transform-vat" },
  { edgeId: 5, label: "query-eu-vat-report → render-pdf" },
  { edgeId: 2, label: "invoices → eu_vat_report" },
  { edgeId: 3, label: "customers → eu_vat_report" },
];

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = new Date("2026-07-22T09:30:00Z").getTime();
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
