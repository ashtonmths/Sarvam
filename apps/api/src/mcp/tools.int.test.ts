import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "../auth/api-keys.js";
import { closePools, sql } from "../db.js";
import { decide } from "../gate/decide.js";
import {
  getNode,
  type McpContext,
  nodeRefInput,
  proposeChange,
  queryBlastRadius,
} from "./tools.js";

/**
 * What the three tools actually do to, and read from, a real graph.
 *
 * The claims under test are the ones the product is sold on: that a BLOCK
 * executes nothing, that an agent's question is scoped to its own
 * organisation, that a read-only question records no enforcement, and that the
 * verdict an agent gets over MCP is the same arithmetic a script gets over
 * REST. Each of those is a database fact and none of them survives a mock.
 */

/* ------------------------------------------------------------- fixtures */

interface Graph {
  orgId: number;
  /** The node a change is proposed against. */
  targetId: number;
  /** Depends on the target, so it appears in the blast radius. */
  dependentId: number;
  edgeId: number;
}

async function seedOrg(slug: string): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${slug}, ${slug}) RETURNING id
  `;
  return Number(row?.id);
}

async function insertNode(
  orgId: number,
  kind: string,
  name: string,
  externalId: string,
  criticality: number,
  connector = "postgres",
): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO nodes (org_id, kind, name, external_id, connector, criticality)
    VALUES (${orgId}, ${kind}::node_kind, ${name}, ${externalId}, ${connector}, ${criticality})
    RETURNING id
  `;
  return Number(row?.id);
}

/** `src` depends on `dst`, which is the direction the traversal walks back. */
async function insertEdge(
  orgId: number,
  srcId: number,
  dstId: number,
  confidence: number,
  provenance = "static_parse",
): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO edges (org_id, src_id, dst_id, kind, confidence, provenance)
    VALUES (${orgId}, ${srcId}, ${dstId}, 'READS_FROM', ${confidence}, ${provenance}::provenance_kind)
    RETURNING id
  `;
  return Number(row?.id);
}

/**
 * One dependent reachable over one trusted edge. The dependent's criticality
 * is what moves the verdict, so each test picks it:
 *
 *   1.0 * 0.9            = 0.90 impact ⇒ BLOCK  (>= 0.8 over a >= 0.7 edge)
 *   0.4 * 0.9            = 0.36 impact ⇒ WARN   (>= 0.3 total)
 *   0.1 * 0.9            = 0.09 impact ⇒ APPROVE
 */
async function seedGraph(slug: string, dependentCriticality: number): Promise<Graph> {
  const orgId = await seedOrg(slug);
  const targetId = await insertNode(
    orgId,
    "field",
    `${slug}.invoices.vat_rate`,
    `${slug}/public/invoices/vat_rate`,
    0.4,
  );
  const dependentId = await insertNode(
    orgId,
    "report",
    `${slug} revenue report`,
    `${slug}/reports/revenue`,
    dependentCriticality,
  );
  const edgeId = await insertEdge(orgId, dependentId, targetId, 0.9);
  return { orgId, targetId, dependentId, edgeId };
}

async function seedKey(orgId: number, scopes: string[], email: string): Promise<number> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash)
    VALUES (${email}, 'Test', 'scrypt$1$1$1$x$x') RETURNING id
  `;
  const created = await createApiKey({
    orgId,
    name: "agent",
    scopes: scopes as never,
    createdBy: Number(user?.id),
  });
  return created.id;
}

function ctxFor(orgId: number, apiKeyId: number, clientName?: string): McpContext {
  return {
    orgId,
    apiKeyId,
    scopes: ["gate:invoke", "graph:read"],
    ...(clientName === undefined ? {} : { clientName }),
  };
}

const fieldChange = (externalId: string) =>
  ({
    target: "field",
    operation: "delete",
    connector: "postgres",
    externalId,
  }) as const;

beforeEach(async () => {
  await sql`TRUNCATE organizations, users CASCADE`;
});

afterAll(async () => {
  await closePools();
});

/* -------------------------------------------------------- propose_change */

describe("propose_change", () => {
  it("blocks a change whose dependent crosses the threshold, and says nothing ran", async () => {
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("BLOCK");
    expect(out.structured.executed).toBe(false);
    expect(out.text).toContain("NOT executed");
    expect(out.text).toContain("Do not retry this change.");
  });

  it("warns when the radius is real but no single node justifies a block", async () => {
    const graph = await seedGraph("acme", 0.4);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("WARN");
    expect(out.text).toContain("WARNING");
  });

  it("approves a change nothing important depends on", async () => {
    const graph = await seedGraph("acme", 0.1);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("APPROVE");
    expect(out.structured.evidence).toEqual([]);
  });

  it("cannot be blocked into silence by a low-confidence edge alone", async () => {
    // An `llm_inferred` edge carries 0.5, below the blocking floor. A model's
    // hunch must never be the thing that stops an engineer's work.
    const orgId = await seedOrg("acme");
    const target = await insertNode(
      orgId,
      "field",
      "vat",
      "acme/public/invoices/vat_rate",
      0.4,
    );
    const dependent = await insertNode(orgId, "report", "revenue", "acme/rep", 1.0);
    await insertEdge(orgId, dependent, target, 0.5, "llm_inferred");
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    expect(out.structured.verdict).not.toBe("BLOCK");
  });

  it("records the decision as an mcp-mode enforcement event", async () => {
    // The mode is what separates "an agent asked" from "CI asked" in the
    // decision log, and the whole Mode 2 story rests on being able to show it.
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    const [row] = await sql<
      { mode: string; dry_run: boolean; actor: string; api_key_id: string; id: string }[]
    >`SELECT id, mode, dry_run, actor, api_key_id FROM gate_decisions`;

    expect(row?.mode).toBe("mcp");
    expect(row?.dry_run).toBe(false);
    expect(Number(row?.api_key_id)).toBe(keyId);
    expect(Number(row?.id)).toBe(out.structured.decision_id);
  });

  it("marks a dry run as a simulation, in the row and in the text", async () => {
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: true,
    });

    const [row] = await sql<{ dry_run: boolean }[]>`SELECT dry_run FROM gate_decisions`;
    expect(row?.dry_run).toBe(true);
    expect(out.text).toContain("This was a simulation");
    // Still a refusal. A simulation is not permission.
    expect(out.structured.verdict).toBe("BLOCK");
  });

  it("warns rather than errors when the target is not on the map", async () => {
    // Unmapped is not safe, so it cannot APPROVE; it is also not a model of
    // anything, so it must not BLOCK. The agent gets a usable answer either
    // way instead of an exception it will retry.
    const orgId = await seedOrg("acme");
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: fieldChange("acme/public/nothing/here"),
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("WARN");
    expect(out.structured.evidence[0]?.rule).toContain("not mapped");
    expect(out.structured.impacted).toEqual([]);
  });

  it("attributes the decision to the agent name the caller supplies", async () => {
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    await proposeChange(ctxFor(graph.orgId, keyId), {
      change: { ...fieldChange("acme/public/invoices/vat_rate"), agent: "claude-code" },
      dry_run: false,
    });

    const [row] = await sql<{ actor: string }[]>`SELECT actor FROM gate_decisions`;
    expect(row?.actor).toBe("agent:claude-code");
  });

  it("falls back to the MCP client name when the change omits an agent", async () => {
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    await proposeChange(ctxFor(graph.orgId, keyId, "cursor"), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    const [row] = await sql<{ actor: string }[]>`SELECT actor FROM gate_decisions`;
    expect(row?.actor).toBe("agent:cursor");
  });

  it("falls back to a placeholder when nothing identifies the caller", async () => {
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    const [row] = await sql<{ actor: string }[]>`SELECT actor FROM gate_decisions`;
    expect(row?.actor).toBe("agent:mcp-client");
  });

  it("caps the structured blast radius at twenty rows while reporting the count honestly", async () => {
    // The cap keeps a wide radius from blowing a context window. The text half
    // still names the real total, so the model is never told a change is small.
    const orgId = await seedOrg("acme");
    const target = await insertNode(
      orgId,
      "field",
      "vat",
      "acme/public/invoices/vat_rate",
      0.4,
    );
    for (let i = 0; i < 25; i++) {
      const dep = await insertNode(orgId, "report", `r${i}`, `acme/rep/${i}`, 0.4);
      await insertEdge(orgId, dep, target, 0.9);
    }
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    expect(out.structured.impacted).toHaveLength(20);
    expect(out.text).toContain("Blast radius (25 nodes reached):");
  });

  it("cannot see, or be blocked by, another organisation's graph", async () => {
    // Two orgs with the same external id: the classic forgotten-predicate
    // shape. Acme's agent must get Acme's answer and no trace of Globex.
    await seedGraph("acme", 0.1);
    const globex = await seedGraph("globex", 1.0);
    const acmeOrg = await sql<
      { id: string }[]
    >`SELECT id FROM organizations WHERE slug = 'acme'`;
    const acmeId = Number(acmeOrg[0]?.id);
    const keyId = await seedKey(acmeId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(acmeId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("APPROVE");
    expect(out.structured.impacted.some((row) => row.nodeId === globex.dependentId)).toBe(
      false,
    );
  });

  it("returns the same verdict a script gets over REST for the same change", async () => {
    // "REST and MCP cannot drift" is a claim in the source. This is the test
    // that makes it one.
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");
    const change = fieldChange("acme/public/invoices/vat_rate");

    const viaMcp = await proposeChange(ctxFor(graph.orgId, keyId), {
      change,
      dry_run: true,
    });
    const viaRest = await decide(change, {
      orgId: graph.orgId,
      mode: "proxy_gate",
      dryRun: true,
      actor: "someone@example.com",
      apiKeyId: keyId,
    });

    expect(viaMcp.structured.verdict).toBe(viaRest.result.verdict);
    expect(viaMcp.structured.evidence).toEqual(viaRest.result.evidence);
    expect(viaMcp.structured.impacted).toEqual(viaRest.result.impacted.slice(0, 20));
  });

  it("returns the same verdict twice for the same change", async () => {
    // Determinism is the product. Two identical questions, two identical
    // answers, no model in the path to disagree with itself. Only the measured
    // compute time may differ, so it is normalized out of the text comparison.
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");
    const change = fieldChange("acme/public/invoices/vat_rate");
    const withoutTiming = (text: string) => text.replace(/in \d+ms/, "in Nms");

    const first = await proposeChange(ctxFor(graph.orgId, keyId), {
      change,
      dry_run: true,
    });
    const second = await proposeChange(ctxFor(graph.orgId, keyId), {
      change,
      dry_run: true,
    });

    expect(second.structured.verdict).toBe(first.structured.verdict);
    expect(second.structured.evidence).toEqual(first.structured.evidence);
    expect(second.structured.impacted).toEqual(first.structured.impacted);
    expect(withoutTiming(second.text)).toBe(withoutTiming(first.text));
  });
});

/* ---------------------------------------------------- query_blast_radius */

describe("query_blast_radius", () => {
  it("returns the dependents of a node", async () => {
    const graph = await seedGraph("acme", 1.0);

    const out = await queryBlastRadius(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.impacted).toHaveLength(1);
    expect(out.structured.impacted[0]?.nodeId).toBe(graph.dependentId);
    expect(out.text).toContain("acme revenue report");
  });

  it("records no decision, because asking is not proposing", async () => {
    // The documented contract for this tool. A read that wrote an enforcement
    // row would inflate every "changes gated" number the product reports.
    const graph = await seedGraph("acme", 1.0);

    await queryBlastRadius(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    const [decisions] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM gate_decisions
    `;
    const [verdicts] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM verdicts`;

    expect(decisions?.n).toBe(0);
    expect(verdicts?.n).toBe(0);
  });

  it("says so plainly when nothing depends on the node", async () => {
    const orgId = await seedOrg("acme");
    await insertNode(orgId, "field", "orphan", "acme/public/x/orphan", 0.4);

    const out = await queryBlastRadius(ctxFor(orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/x/orphan",
    });

    expect(out.structured.impacted).toEqual([]);
    expect(out.text).toBe("Nothing depends on that node.");
  });

  it("refuses a node the graph has never seen rather than answering 'nothing'", async () => {
    // "No dependents" and "no such node" are different claims, and conflating
    // them tells an agent a change is safe when nobody has ever looked.
    const orgId = await seedOrg("acme");

    await expect(
      queryBlastRadius(ctxFor(orgId, 0), {
        connector: "postgres",
        externalId: "acme/public/x/never-seen",
      }),
    ).rejects.toThrow(/No node matches/);
  });

  it("cannot read another organisation's node", async () => {
    const acme = await seedGraph("acme", 1.0);
    await seedGraph("globex", 1.0);

    await expect(
      queryBlastRadius(ctxFor(acme.orgId, 0), {
        connector: "postgres",
        externalId: "globex/public/invoices/vat_rate",
      }),
    ).rejects.toThrow(/No node matches/);
  });

  it("resolves a node on any connector, not only the one the descriptor names", async () => {
    // The tool synthesizes a field/delete descriptor to reuse the resolver, so
    // the connector in the request is the only part that has to be honoured.
    const orgId = await seedOrg("acme");
    const workflow = await insertNode(
      orgId,
      "workflow",
      "Billing run",
      "wf_1",
      0.4,
      "n8n",
    );
    const dependent = await insertNode(
      orgId,
      "report",
      "Revenue",
      "acme/rep",
      1.0,
      "postgres",
    );
    await insertEdge(orgId, dependent, workflow, 0.9);

    const out = await queryBlastRadius(ctxFor(orgId, 0), {
      connector: "n8n",
      externalId: "wf_1",
    });

    expect(out.structured.impacted).toHaveLength(1);
    expect(out.structured.impacted[0]?.name).toBe("Revenue");
  });
});

/* --------------------------------------------------------------- get_node */

describe("get_node", () => {
  it("returns the node with its criticality and direct edges", async () => {
    const graph = await seedGraph("acme", 1.0);

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.found).toBe(true);
    expect(out.structured.node?.name).toBe("acme.invoices.vat_rate");
    expect(out.structured.node?.criticality).toBeCloseTo(0.4);
    expect(out.structured.edges).toHaveLength(1);
    expect(out.text).toContain("criticality 0.4");
    expect(out.text).toContain("1 direct edges");
  });

  it("returns edges in both directions, since dependency runs both ways", async () => {
    const graph = await seedGraph("acme", 1.0);
    const upstream = await insertNode(graph.orgId, "table", "source", "acme/src", 0.4);
    await insertEdge(graph.orgId, graph.targetId, upstream, 0.9);

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.edges).toHaveLength(2);
  });

  it("carries the confirmed rationale that explains this node's edges", async () => {
    const graph = await seedGraph("acme", 1.0);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
      VALUES (${graph.orgId}, 'VAT rate feeds the revenue report', 'slack',
              'https://slack.com/archives/C1/p1', 'priya', 'confirmed', now())
      RETURNING id
    `;
    await sql`
      INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${graph.edgeId})
    `;

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.rationale).toHaveLength(1);
    expect(out.structured.rationale?.[0]?.author).toBe("priya");
    expect(out.text).toContain("VAT rate feeds the revenue report");
    expect(out.text).toContain("https://slack.com/archives/C1/p1");
  });

  it("never presents a draft as though a human had confirmed it", async () => {
    // A drafted rationale is a model's guess. Attributing it to the named
    // author, next to their real permalink, is a claim they never made.
    const graph = await seedGraph("acme", 1.0);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state)
      VALUES (${graph.orgId}, 'a model guessed this', 'slack',
              'https://slack.com/archives/C1/p2', 'priya', 'drafted')
      RETURNING id
    `;
    await sql`
      INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${graph.edgeId})
    `;

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.rationale).toEqual([]);
  });

  it("does not attach rationale that belongs to an unrelated node", async () => {
    // Regression for the unconstrained join called out in the source: it
    // returned any confirmed rationale in the organisation, which the caller
    // then presented as the reasoning behind *this* node — a real author and a
    // real permalink attached to a claim they never made about it.
    const graph = await seedGraph("acme", 1.0);
    const otherA = await insertNode(graph.orgId, "table", "other a", "acme/other/a", 0.4);
    const otherB = await insertNode(graph.orgId, "table", "other b", "acme/other/b", 0.4);
    const unrelatedEdge = await insertEdge(graph.orgId, otherA, otherB, 0.9);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
      VALUES (${graph.orgId}, 'about something else entirely', 'slack',
              'https://slack.com/archives/C9/p9', 'dev', 'confirmed', now())
      RETURNING id
    `;
    await sql`
      INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${unrelatedEdge})
    `;

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.rationale).toEqual([]);
    expect(out.text).not.toContain("about something else entirely");
  });

  it("answers 'no such node' rather than throwing, so the agent can move on", async () => {
    const orgId = await seedOrg("acme");

    const out = await getNode(ctxFor(orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/x/never-seen",
    });

    expect(out.structured.found).toBe(false);
    expect(out.text).toBe("No such node in this graph.");
  });

  it("cannot read a node belonging to another organisation", async () => {
    const acme = await seedGraph("acme", 1.0);
    await seedGraph("globex", 1.0);

    const out = await getNode(ctxFor(acme.orgId, 0), {
      connector: "postgres",
      externalId: "globex/public/invoices/vat_rate",
    });

    expect(out.structured.found).toBe(false);
  });

  it("cannot be shown another organisation's rationale through a shared node name", async () => {
    const acme = await seedGraph("acme", 1.0);
    const globex = await seedGraph("globex", 1.0);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
      VALUES (${globex.orgId}, 'globex internal reasoning', 'slack',
              'https://slack.com/archives/G1/p1', 'globex-dev', 'confirmed', now())
      RETURNING id
    `;
    await sql`
      INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${globex.edgeId})
    `;

    const out = await getNode(ctxFor(acme.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.rationale).toEqual([]);
    expect(out.text).not.toContain("globex internal reasoning");
  });

  it("refuses another organisation's rationale even when a link points straight at our edge", async () => {
    // `edges` cannot cross organisations — the composite foreign keys refuse
    // it, which `tenant.int.test.ts` proves. `rationale_links` has no such
    // constraint: it is two plain foreign keys and a composite primary key, so
    // a row joining Globex's rationale to Acme's edge inserts cleanly.
    //
    // That makes the org predicate in `getNode` load-bearing rather than
    // belt-and-braces. Without it, one bad link publishes a named author and a
    // real permalink from another tenant into Acme's answer. Mutation testing
    // is what surfaced this: deleting that predicate left every other test
    // green, because they all relied on edge scoping to do the work.
    const acme = await seedGraph("acme", 1.0);
    const globex = await seedGraph("globex", 1.0);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
      VALUES (${globex.orgId}, 'globex private reasoning', 'slack',
              'https://slack.com/archives/G1/p2', 'globex-dev', 'confirmed', now())
      RETURNING id
    `;
    await sql`
      INSERT INTO rationale_links (rationale_id, edge_id)
      VALUES (${Number(r?.id)}, ${acme.edgeId})
    `;

    const out = await getNode(ctxFor(acme.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.rationale).toEqual([]);
    expect(out.text).not.toContain("globex private reasoning");
    expect(out.text).not.toContain("globex-dev");
  });

  /*
   * Not tested, deliberately: dropping `eq(edgesTable.orgId, ctx.orgId)` from
   * the direct-edge query is an equivalent mutation. The anchor node is
   * resolved inside the organisation, and `edges_src_org_fk` / `edges_dst_org_fk`
   * make an edge touching it from another organisation unrepresentable — so
   * there is no database state in which the predicate changes the answer. A
   * test asserting otherwise would be asserting against the schema, not the
   * code.
   */
});

/* -------------------------------------------- targets beyond a field */

describe("the targets other than a field", () => {
  it("gates a workflow change on n8n", async () => {
    // `field` is the demo case and the only one the other suites exercise.
    // A workflow is the target an n8n agent actually proposes against, and it
    // travels a different branch of the discriminated union to get here.
    const orgId = await seedOrg("acme");
    const workflow = await insertNode(
      orgId,
      "workflow",
      "Billing run",
      "wf_1",
      0.4,
      "n8n",
    );
    const report = await insertNode(orgId, "report", "Revenue", "acme/rep", 1.0);
    await insertEdge(orgId, report, workflow, 0.9);
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: {
        target: "workflow",
        operation: "disable",
        connector: "n8n",
        externalId: "wf_1",
      },
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("BLOCK");
    expect(out.text).toContain('Change: disable workflow "wf_1"');
  });

  it("gates a credential revocation, on any connector that can hold one", async () => {
    const orgId = await seedOrg("acme");
    const cred = await insertNode(
      orgId,
      "credential",
      "Slack bot token",
      "cred_1",
      0.4,
      "slack",
    );
    const workflow = await insertNode(orgId, "workflow", "Alerts", "wf_2", 1.0, "n8n");
    await insertEdge(orgId, workflow, cred, 0.9);
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: {
        target: "credential",
        operation: "revoke",
        connector: "slack",
        externalId: "cred_1",
      },
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("BLOCK");
    expect(out.text).toContain('Change: revoke credential "cred_1"');
  });
});

/* ------------------------------------------------ the scoring model, via MCP */

describe("the impact model as an agent sees it", () => {
  it("decays a distant dependent below the blocking threshold", async () => {
    // Three hops out, a maximally critical node scores 1.0 * 0.9^3 * 0.6^2 =
    // 0.26 — visible on the map, and correctly not a block. Reaching this
    // through the tool is what proves the agent sees the same decay the UI does.
    const orgId = await seedOrg("acme");
    const target = await insertNode(orgId, "field", "vat", "acme/vat", 0.4);
    const one = await insertNode(orgId, "table", "one", "acme/1", 0.1);
    const two = await insertNode(orgId, "table", "two", "acme/2", 0.1);
    const far = await insertNode(orgId, "report", "far", "acme/3", 1.0);
    await insertEdge(orgId, one, target, 0.9);
    await insertEdge(orgId, two, one, 0.9);
    await insertEdge(orgId, far, two, 0.9);
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: fieldChange("acme/vat"),
      dry_run: false,
    });

    const farRow = out.structured.impacted.find((r) => r.nodeId === far);
    expect(farRow?.hops).toBe(3);
    expect(farRow?.impact).toBeLessThan(0.8);
    expect(out.structured.verdict).not.toBe("BLOCK");
  });

  it("surfaces a sole-owner dependency as its own reason to warn", async () => {
    // Bus factor 1 warns even when the impact arithmetic alone would approve.
    // The agent needs the distinct reason, not just the verdict letter.
    const orgId = await seedOrg("acme");
    const target = await insertNode(orgId, "field", "vat", "acme/vat", 0.4);
    const dependent = await insertNode(orgId, "report", "small", "acme/rep", 0.1);
    const edge = await insertEdge(orgId, dependent, target, 0.9);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
      VALUES (${orgId}, 'only priya knows', 'slack', 'https://s/1', 'priya', 'confirmed', now())
      RETURNING id
    `;
    await sql`INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${edge})`;
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: fieldChange("acme/vat"),
      dry_run: false,
    });

    expect(out.structured.verdict).toBe("WARN");
    expect(out.structured.evidence.some((e) => e.rule.includes("only one person"))).toBe(
      true,
    );
    expect(out.text).toContain("only one person can explain this dependency");
  });

  it("does not route blast radius through a tombstoned edge", async () => {
    // Cartographer marks stale rather than deleting. A dead dependency that
    // still blocks a merge is a wrong answer that costs someone an afternoon.
    const orgId = await seedOrg("acme");
    const target = await insertNode(orgId, "field", "vat", "acme/vat", 0.4);
    const dependent = await insertNode(orgId, "report", "gone", "acme/rep", 1.0);
    await insertEdge(orgId, dependent, target, 0.9);
    await sql`UPDATE edges SET state = 'stale', stale_since = now()`;
    const keyId = await seedKey(orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(orgId, keyId), {
      change: fieldChange("acme/vat"),
      dry_run: false,
    });

    expect(out.structured.impacted).toEqual([]);
    expect(out.structured.verdict).toBe("APPROVE");
  });

  it("points verdict_id at the persisted verdict a human can later open", async () => {
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });

    const [row] = await sql<{ id: string; verdict: string; org_id: string }[]>`
      SELECT id, verdict, org_id FROM verdicts WHERE id = ${out.structured.verdict_id}
    `;
    expect(row?.verdict).toBe("BLOCK");
    expect(Number(row?.org_id)).toBe(graph.orgId);
    expect(typeof out.structured.computed_in_ms).toBe("number");
  });
});

/* ------------------------------------------------------- truncation limits */

describe("the limits that keep a reply inside a context window", () => {
  it("prints at most fifteen blast-radius lines", async () => {
    const orgId = await seedOrg("acme");
    const target = await insertNode(orgId, "field", "vat", "acme/vat", 0.4);
    for (let i = 0; i < 20; i++) {
      const dep = await insertNode(orgId, "report", `r${i}`, `acme/rep/${i}`, 0.4);
      await insertEdge(orgId, dep, target, 0.9);
    }

    const out = await queryBlastRadius(ctxFor(orgId, 0), {
      connector: "postgres",
      externalId: "acme/vat",
    });

    expect(out.structured.impacted).toHaveLength(20);
    expect(out.text.split("\n")).toHaveLength(15);
  });

  it("returns at most fifty direct edges from get_node", async () => {
    const orgId = await seedOrg("acme");
    const target = await insertNode(orgId, "field", "vat", "acme/vat", 0.4);
    for (let i = 0; i < 60; i++) {
      const dep = await insertNode(orgId, "table", `t${i}`, `acme/t/${i}`, 0.4);
      await insertEdge(orgId, dep, target, 0.9);
    }

    const out = await getNode(ctxFor(orgId, 0), {
      connector: "postgres",
      externalId: "acme/vat",
    });

    expect(out.structured.edges).toHaveLength(50);
  });

  it("returns at most ten rationale, newest confirmation first", async () => {
    const graph = await seedGraph("acme", 1.0);
    for (let i = 0; i < 12; i++) {
      const [r] = await sql<{ id: string }[]>`
        INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
        VALUES (${graph.orgId}, ${`note ${i}`}, 'slack', ${`https://s/${i}`}, ${`author${i}`},
                'confirmed', now() + (${i} || ' seconds')::interval)
        RETURNING id
      `;
      await sql`
        INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${graph.edgeId})
      `;
    }

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.rationale).toHaveLength(10);
    expect(out.structured.rationale?.[0]?.body).toBe("note 11");
  });

  it("quotes only the first 160 characters of a long rationale", async () => {
    const graph = await seedGraph("acme", 1.0);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
      VALUES (${graph.orgId}, ${"z".repeat(400)}, 'slack', 'https://s/1', 'priya', 'confirmed', now())
      RETURNING id
    `;
    await sql`INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${graph.edgeId})`;

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.structured.rationale?.[0]?.body).toHaveLength(400);
    expect(out.text).toContain(`"${"z".repeat(160)}" — priya`);
    expect(out.text).not.toContain("z".repeat(161));
  });

  it("names an unattributed rationale 'unknown' rather than printing nothing", async () => {
    const graph = await seedGraph("acme", 1.0);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO rationale (org_id, body, source_kind, source_url, author, state, confirmed_at)
      VALUES (${graph.orgId}, 'from a doc nobody signed', 'doc', 'https://s/1', NULL, 'confirmed', now())
      RETURNING id
    `;
    await sql`INSERT INTO rationale_links (rationale_id, edge_id) VALUES (${Number(r?.id)}, ${graph.edgeId})`;

    const out = await getNode(ctxFor(graph.orgId, 0), {
      connector: "postgres",
      externalId: "acme/public/invoices/vat_rate",
    });

    expect(out.text).toContain("— unknown https://s/1");
  });

  it("skips the rationale query entirely for a node with no edges", async () => {
    const orgId = await seedOrg("acme");
    await insertNode(orgId, "field", "lonely", "acme/lonely", 0.4);

    const out = await getNode(ctxFor(orgId, 0), {
      connector: "postgres",
      externalId: "acme/lonely",
    });

    expect(out.structured.edges).toEqual([]);
    expect(out.structured.rationale).toEqual([]);
    expect(out.text).toContain("0 direct edges");
  });
});

/* ------------------------------------------------- the documented contract */

/**
 * `apps/web/content/docs/mcp.mdx` is the page an agent builder writes against.
 * These assert what the tools *actually* return, so the gap between the two is
 * a failing expectation rather than a support ticket.
 */
describe("the contract the docs page promises", () => {
  it("DOCS GAP: evidence has none of the fields the sample response shows", async () => {
    // The page prints evidence entries as
    //   { node, kind, hops, impact, provenance, why }
    // and describes `why` as "a human's confirmed explanation with a
    // permalink". The real shape is { rule, nodeId, name, impact } — no
    // permalink, no author, and no `why` anywhere in the payload. A builder
    // who parses the documented shape gets undefined for every field but one.
    const graph = await seedGraph("acme", 1.0);
    const keyId = await seedKey(graph.orgId, ["gate:invoke"], "a@example.com");

    const out = await proposeChange(ctxFor(graph.orgId, keyId), {
      change: fieldChange("acme/public/invoices/vat_rate"),
      dry_run: false,
    });
    const [first] = out.structured.evidence;

    expect(Object.keys(first ?? {}).sort()).toEqual(["impact", "name", "nodeId", "rule"]);
    expect(first).not.toHaveProperty("why");
    expect(first).not.toHaveProperty("provenance");
    expect(JSON.stringify(out.structured)).not.toContain("sourceUrl");
  });

  it("DOCS GAP: only propose_change accepts dry_run, though the page says every tool does", async () => {
    // "Every tool accepts `dry_run`. Use it in development." Two of the three
    // do not have the key in their schema at all, so a developer following the
    // instruction gets a validation error from the read-only tools.
    expect(() =>
      nodeRefInput.parse({ connector: "postgres", externalId: "x", dry_run: true }),
    ).not.toThrow();
    expect(
      nodeRefInput.parse({ connector: "postgres", externalId: "x" }),
    ).not.toHaveProperty("dry_run");
  });
});
