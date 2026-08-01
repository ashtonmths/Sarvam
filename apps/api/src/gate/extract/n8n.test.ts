import { describe, expect, it } from "vitest";
import { extractFromN8n, isN8nWorkflowFile } from "./n8n.js";

const workflow = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "wf_123",
    name: "billing-sync",
    active: true,
    nodes: [
      { id: "n1", name: "Fetch invoices", type: "n8n-nodes-base.postgres" },
      { id: "n2", name: "Transform VAT", type: "n8n-nodes-base.set" },
    ],
    ...over,
  });

describe("workflow deletion", () => {
  it("treats a removed file as a workflow delete", () => {
    const result = extractFromN8n("workflows/billing.json", workflow(), null);
    expect(result.changes).toEqual([
      {
        target: "workflow",
        connector: "n8n",
        operation: "delete",
        externalId: "workflow/wf_123",
      },
    ]);
  });

  it("treats a new file as no change at all", () => {
    // A workflow that did not exist before cannot break anything that
    // depended on it.
    const result = extractFromN8n("workflows/new.json", null, workflow());
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns).toHaveLength(0);
  });
});

describe("deactivation", () => {
  it("extracts active true → false as a disable", () => {
    const result = extractFromN8n(
      "workflows/billing.json",
      workflow({ active: true }),
      workflow({ active: false }),
    );
    expect(result.changes[0]).toMatchObject({ operation: "disable" });
  });

  it("does not flag a workflow that stays active", () => {
    const result = extractFromN8n("w.json", workflow(), workflow());
    expect(result.changes).toHaveLength(0);
  });
});

describe("step removal, diffed by id", () => {
  it("extracts a removed step", () => {
    const after = workflow({
      nodes: [{ id: "n1", name: "Fetch invoices", type: "n8n-nodes-base.postgres" }],
    });
    const result = extractFromN8n("w.json", workflow(), after);
    expect(result.changes).toEqual([
      {
        target: "workflow",
        connector: "n8n",
        operation: "delete",
        externalId: "workflow/wf_123/node/n2",
      },
    ]);
  });

  it("does not treat reordering as a deletion", () => {
    // Diffing by position rather than id would block every harmless PR that
    // moves a node around the canvas.
    const reordered = workflow({
      nodes: [
        { id: "n2", name: "Transform VAT", type: "n8n-nodes-base.set" },
        { id: "n1", name: "Fetch invoices", type: "n8n-nodes-base.postgres" },
      ],
    });
    const result = extractFromN8n("w.json", workflow(), reordered);
    expect(result.changes).toHaveLength(0);
  });

  it("does not treat a rename as a deletion when the id is stable", () => {
    const renamed = workflow({
      nodes: [
        { id: "n1", name: "Fetch invoices (v2)", type: "n8n-nodes-base.postgres" },
        { id: "n2", name: "Transform VAT", type: "n8n-nodes-base.set" },
      ],
    });
    expect(extractFromN8n("w.json", workflow(), renamed).changes).toHaveLength(0);
  });
});

describe("conservative refusals", () => {
  it("flags an export with no id rather than guessing", () => {
    const result = extractFromN8n("w.json", JSON.stringify({ name: "no id" }), null);
    expect(result.changes).toHaveLength(0);
    expect(result.unknowns[0]?.reason).toMatch(/no id/);
  });

  it("treats unparseable JSON as absent rather than as a change", () => {
    const result = extractFromN8n("w.json", "{not json", workflow());
    expect(result.changes).toHaveLength(0);
  });

  it("never infers a field-reference change from step parameters", () => {
    // That is llm-inferred territory and has no business in a hard gate.
    const before = workflow({
      nodes: [
        {
          id: "n1",
          name: "q",
          type: "n8n-nodes-base.postgres",
          parameters: { table: "invoices" },
        },
      ],
    });
    const after = workflow({
      nodes: [
        {
          id: "n1",
          name: "q",
          type: "n8n-nodes-base.postgres",
          parameters: { table: "customers" },
        },
      ],
    });
    expect(extractFromN8n("w.json", before, after).changes).toHaveLength(0);
  });
});

describe("file selection", () => {
  it("matches conventional workflow paths", () => {
    expect(isN8nWorkflowFile("workflows/billing.json", null)).toBe(true);
    expect(isN8nWorkflowFile("n8n/flows/x.json", null)).toBe(true);
  });

  it("honors an explicit configured prefix", () => {
    expect(isN8nWorkflowFile("automation/a.json", "automation/")).toBe(true);
    expect(isN8nWorkflowFile("workflows/a.json", "automation/")).toBe(false);
  });

  it("ignores non-JSON and unrelated JSON", () => {
    expect(isN8nWorkflowFile("workflows/readme.md", null)).toBe(false);
    expect(isN8nWorkflowFile("package.json", null)).toBe(false);
  });
});
