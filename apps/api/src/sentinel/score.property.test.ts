import type { BlastRow } from "@sadhak/shared/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BLOCKING_CONFIDENCE, DECAY, decayedImpact, verdict } from "./score.js";

/**
 * Golden tests pin examples; property tests pin the rules.
 *
 * A failing counterexample is replayable: fast-check prints the seed, and
 * `fc.assert(prop, { seed })` reproduces it locally rather than leaving it as
 * folklore.
 */

const arbRow = (over: Partial<BlastRow> = {}) =>
  fc
    .record({
      nodeId: fc.integer({ min: 1, max: 10_000 }),
      name: fc.string({ minLength: 1, maxLength: 20 }),
      kind: fc.constantFrom("table", "field", "workflow", "report"),
      hops: fc.integer({ min: 1, max: 6 }),
      criticality: fc.constantFrom(1.0, 0.7, 0.4, 0.1),
      pathConfidence: fc.float({ min: Math.fround(0.05), max: 1, noNaN: true }),
      minEdgeConfidence: fc.float({ min: Math.fround(0.05), max: 1, noNaN: true }),
      impact: fc.float({ min: 0, max: 1, noNaN: true }),
      busFactor: fc.integer({ min: 0, max: 5 }),
      path: fc.constant([]),
    })
    .map((row) => ({ ...row, ...over }) as BlastRow);

describe("the trust rule — an llm_inferred edge alone never blocks", () => {
  it("never returns BLOCK when every path is below the blocking confidence", () => {
    fc.assert(
      fc.property(
        fc.array(
          arbRow().map((row) => ({
            ...row,
            // Every row reached over an edge too speculative to block on —
            // regardless of impact, criticality, or how many there are.
            minEdgeConfidence: 0.5,
            impact: 1.0,
            criticality: 1.0,
          })),
          { minLength: 1, maxLength: 40 },
        ),
        (rows) => verdict(rows).verdict !== "BLOCK",
      ),
      { numRuns: 500 },
    );
  });

  it("blocks only when some row clears both the confidence and impact bars", () => {
    fc.assert(
      fc.property(fc.array(arbRow(), { minLength: 1, maxLength: 30 }), (rows) => {
        const result = verdict(rows);
        if (result.verdict !== "BLOCK") return true;
        return rows.some(
          (r) => r.minEdgeConfidence >= BLOCKING_CONFIDENCE && r.impact >= 0.8,
        );
      }),
      { numRuns: 500 },
    );
  });
});

describe("decay monotonicity", () => {
  it("is non-increasing in hops and never exceeds criticality × pathConfidence", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1.0, 0.7, 0.4, 0.1),
        fc.float({ min: Math.fround(0.05), max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 6 }),
        (criticality, pathConfidence, hops) => {
          const here = decayedImpact(criticality, pathConfidence, hops);
          const further = decayedImpact(criticality, pathConfidence, hops + 1);
          return here >= further - 1e-9 && here <= criticality * pathConfidence + 1e-9;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("decays by exactly DECAY per additional hop", () => {
    expect(decayedImpact(1, 1, 2)).toBeCloseTo(DECAY, 10);
    expect(decayedImpact(1, 1, 3)).toBeCloseTo(DECAY ** 2, 10);
  });
});

describe("order invariance", () => {
  it("gives the same verdict and the same evidence set for shuffled rows", () => {
    fc.assert(
      fc.property(
        fc.array(arbRow(), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 0, max: 1000 }),
        (rows, seed) => {
          const shuffled = [...rows].sort(
            (a, b) => ((a.nodeId * seed) % 97) - ((b.nodeId * seed) % 97),
          );
          const first = verdict(rows);
          const second = verdict(shuffled);

          // A hidden order dependency here would break golden reproducibility,
          // so evidence is compared as a multiset rather than a sequence.
          const key = (e: { rule: string; nodeId: number }) => `${e.rule}::${e.nodeId}`;
          return (
            first.verdict === second.verdict &&
            first.evidence.map(key).sort().join("|") ===
              second.evidence.map(key).sort().join("|")
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("evidence totality", () => {
  it("gives every non-APPROVE verdict at least one evidence entry", () => {
    fc.assert(
      fc.property(fc.array(arbRow(), { minLength: 0, maxLength: 30 }), (rows) => {
        const result = verdict(rows);
        return result.verdict === "APPROVE" || result.evidence.length > 0;
      }),
      { numRuns: 500 },
    );
  });

  it("approves an empty blast radius", () => {
    expect(verdict([]).verdict).toBe("APPROVE");
  });
});

describe("bus factor semantics", () => {
  it("warns on exactly one author, not on zero", () => {
    // Zero means *unexplained*. An edge nobody documented must not masquerade
    // as a key-person risk.
    const unexplained = verdict([
      { ...baseRow(), busFactor: 0, impact: 0.1, criticality: 0.1 },
    ]);
    expect(unexplained.evidence.some((e) => e.rule.includes("only one person"))).toBe(
      false,
    );

    const soleOwner = verdict([
      { ...baseRow(), busFactor: 1, impact: 0.1, criticality: 0.1 },
    ]);
    expect(soleOwner.verdict).toBe("WARN");
    expect(soleOwner.evidence.some((e) => e.rule.includes("only one person"))).toBe(true);
  });
});

function baseRow(): BlastRow {
  return {
    nodeId: 1,
    name: "node",
    kind: "table",
    hops: 1,
    criticality: 0.4,
    pathConfidence: 1,
    minEdgeConfidence: 1,
    impact: 0.4,
    busFactor: 3,
    path: [],
  };
}
