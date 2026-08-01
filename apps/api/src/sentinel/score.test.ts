import type { BlastRow } from "@sadhak/shared/types";
import { describe, expect, it } from "vitest";
import { BLOCK_IMPACT, DECAY, decayedImpact, verdict } from "./score.js";

function row(over: Partial<BlastRow> = {}): BlastRow {
  return {
    nodeId: 1,
    name: "node",
    kind: "workflow",
    hops: 1,
    criticality: 0.4,
    pathConfidence: 1,
    minEdgeConfidence: 1,
    impact: 0.4,
    busFactor: 3,
    ...over,
  };
}

describe("decayedImpact", () => {
  it("does not decay the directly connected node", () => {
    expect(decayedImpact(1, 1, 1)).toBe(1);
  });

  it("decays with distance", () => {
    const near = decayedImpact(1, 1, 1);
    const mid = decayedImpact(1, 1, 3);
    const far = decayedImpact(1, 1, 6);
    expect(mid).toBeLessThan(near);
    expect(far).toBeLessThan(mid);
    // Six hops out, a maximally critical node contributes almost nothing.
    // It shows on the map. It does not raise an alarm.
    expect(far).toBeCloseTo(Math.pow(DECAY, 5), 5);
    expect(far).toBeLessThan(0.1);
  });

  it("compounds edge confidence along the path", () => {
    expect(decayedImpact(1, 0.5, 1)).toBe(0.5);
  });
});

describe("verdict", () => {
  it("blocks when a revenue touching node is reached over trusted edges", () => {
    const rows = [
      row({ name: "billing-sync-flow", criticality: 1, impact: 0.94, minEdgeConfidence: 1 }),
    ];
    const result = verdict(rows);
    expect(result.verdict).toBe("BLOCK");
    expect(result.evidence[0]?.name).toBe("billing-sync-flow");
  });

  // The trust preserving rule. An llm_inferred edge carries confidence 0.5,
  // so no matter how critical the node it reaches, it can only warn.
  it("never blocks on an llm inferred edge alone", () => {
    const rows = [
      row({ name: "billing-sync-flow", criticality: 1, impact: 0.94, minEdgeConfidence: 0.5 }),
    ];
    const result = verdict(rows);
    expect(result.verdict).toBe("WARN");
  });

  it("blocks when a trusted path exists alongside an inferred one", () => {
    const rows = [
      row({ nodeId: 1, impact: 0.94, minEdgeConfidence: 0.5 }),
      row({ nodeId: 2, name: "eu-vat-report", impact: 0.85, minEdgeConfidence: 0.8 }),
    ];
    expect(verdict(rows).verdict).toBe("BLOCK");
  });

  it("warns when a single person is the only source of rationale", () => {
    const rows = [row({ impact: 0.05, busFactor: 1, name: "legacy-export" })];
    const result = verdict(rows);
    expect(result.verdict).toBe("WARN");
    expect(result.evidence.some((e) => e.rule.includes("one person"))).toBe(true);
  });

  it("approves an isolated low impact change", () => {
    expect(verdict([row({ impact: 0.05 })]).verdict).toBe("APPROVE");
  });

  it("approves when nothing downstream is reachable", () => {
    expect(verdict([]).verdict).toBe("APPROVE");
  });

  it("warns on aggregate impact even when no single node blocks", () => {
    const rows = [
      row({ nodeId: 1, impact: 0.15 }),
      row({ nodeId: 2, impact: 0.12 }),
      row({ nodeId: 3, impact: 0.09 }),
    ];
    const result = verdict(rows);
    expect(result.verdict).toBe("WARN");
    expect(rows.every((r) => r.impact < BLOCK_IMPACT)).toBe(true);
  });

  it("always explains itself", () => {
    const rows = [row({ impact: 0.9, minEdgeConfidence: 1, criticality: 1 })];
    expect(verdict(rows).evidence.length).toBeGreaterThan(0);
  });
});
