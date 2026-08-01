import { describe, expect, it } from "vitest";
import type { NodeSpec } from "../connectors/types.js";
import { UserError } from "../errors.js";
import { CONFIDENCE, confidenceFor, normalizeEdge, normalizeNode } from "./normalize.js";

const validField: NodeSpec = {
  key: { connector: "postgres", externalId: "1/db/app/column/public.invoices.vat_rate" },
  kind: "field",
  name: "invoices.vat_rate",
  metadata: { columnType: "numeric", isNullable: false },
};

describe("the payload firewall", () => {
  it("accepts allowlisted structural metadata", () => {
    const node = normalizeNode(validField);
    expect(node.metadata).toEqual({ columnType: "numeric", isNullable: false });
  });

  it("rejects a hostile spec smuggling rows under an unknown key", () => {
    expect(() =>
      normalizeNode({ ...validField, metadata: { rows: [{ vat_rate: 0.25 }] } }),
    ).toThrow(UserError);
  });

  it("rejects sample values even alongside legitimate keys", () => {
    expect(() =>
      normalizeNode({
        ...validField,
        metadata: { columnType: "numeric", sampleValues: [0.19, 0.25] },
      }),
    ).toThrow(UserError);
  });

  it("refuses a spec with no identity key", () => {
    expect(() =>
      normalizeNode({ ...validField, key: { connector: "postgres", externalId: "" } }),
    ).toThrow(UserError);
  });
});

describe("provenance is the only source of confidence", () => {
  it("maps each provenance to its fixed confidence", () => {
    expect(confidenceFor("static_parse")).toBe(1.0);
    expect(confidenceFor("runtime_observed")).toBe(0.8);
    // Present in the table for the scorer, but not reachable from a connector.
    expect(CONFIDENCE.llm_inferred).toBe(0.5);
  });

  it("derives edge confidence rather than accepting a connector's claim", () => {
    const edge = normalizeEdge({
      src: { connector: "postgres", externalId: "view/eu_vat_report" },
      dst: { connector: "postgres", externalId: "column/invoices.vat_rate" },
      kind: "DERIVES_FROM",
      provenance: "static_parse",
    });
    expect(edge.confidence).toBe(1.0);
    expect(edge.provenance).toBe("static_parse");
  });

  it("does not let a connector emit an llm_inferred edge", () => {
    normalizeEdge({
      src: { connector: "n8n", externalId: "a" },
      dst: { connector: "n8n", externalId: "b" },
      kind: "READS_FROM",
      // @ts-expect-error — llm_inferred belongs to Historian and Reviewer, and
      // is deliberately unrepresentable in connector output.
      provenance: "llm_inferred",
    });
  });

  it("refuses a self-edge", () => {
    expect(() =>
      normalizeEdge({
        src: { connector: "n8n", externalId: "same" },
        dst: { connector: "n8n", externalId: "same" },
        kind: "READS_FROM",
        provenance: "static_parse",
      }),
    ).toThrow(UserError);
  });
});
