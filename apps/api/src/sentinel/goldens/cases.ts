import type { BlastRow } from "@sadhak/shared/types";

/**
 * The golden corpus inputs.
 *
 * "Same graph, same change, same verdict, every time" is the property the
 * whole trust story rests on, so these cases sit on the decision boundaries
 * rather than in the comfortable middle of them. A scoring change that moves a
 * threshold by 0.01 should light this suite up, which is the entire point.
 *
 * Cases are hand-built rather than crawled so each one names the rule it
 * pins. The seeded demo graph is exercised end to end by the e2e suite; this
 * corpus is about the kernel's arithmetic.
 */

export interface GoldenCase {
  name: string;
  /** The rule or locked decision this case exists to pin. */
  pins: string;
  rows: BlastRow[];
}

function row(over: Partial<BlastRow> & { nodeId: number }): BlastRow {
  return {
    name: `node-${over.nodeId}`,
    kind: "table",
    hops: 1,
    criticality: 1,
    pathConfidence: 1,
    minEdgeConfidence: 1,
    impact: 1,
    busFactor: 0,
    path: [],
    ...over,
  };
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: "empty-blast-radius",
    pins: "Nothing downstream is an APPROVE, not a WARN.",
    rows: [],
  },
  {
    name: "block-at-threshold",
    pins: "impact exactly at BLOCK_IMPACT (0.8) over a trusted edge blocks.",
    rows: [row({ nodeId: 1, impact: 0.8, minEdgeConfidence: 1 })],
  },
  {
    name: "just-below-block-threshold",
    pins: "impact 0.79 does not block. The boundary is inclusive on one side only.",
    rows: [row({ nodeId: 1, impact: 0.79, minEdgeConfidence: 1 })],
  },
  {
    name: "high-impact-over-inferred-edge",
    pins:
      "LOCKED: an llm_inferred edge (confidence 0.5) can never on its own BLOCK, " +
      "however high the impact. Blocking someone's Friday on a model's hunch is " +
      "how the gate loses trust permanently.",
    rows: [row({ nodeId: 1, impact: 1, minEdgeConfidence: 0.5 })],
  },
  {
    name: "confidence-exactly-at-blocking-threshold",
    pins: "minEdgeConfidence exactly 0.7 is trusted enough to block.",
    rows: [row({ nodeId: 1, impact: 0.9, minEdgeConfidence: 0.7 })],
  },
  {
    name: "confidence-just-below-blocking-threshold",
    pins: "0.69 is not, so a runtime-observed edge that decayed cannot block alone.",
    rows: [row({ nodeId: 1, impact: 0.9, minEdgeConfidence: 0.69 })],
  },
  {
    name: "many-small-impacts-sum-to-warn",
    pins: "No single node is alarming, but the total crosses WARN_TOTAL_IMPACT.",
    rows: [
      row({ nodeId: 1, impact: 0.11 }),
      row({ nodeId: 2, impact: 0.11 }),
      row({ nodeId: 3, impact: 0.11 }),
    ],
  },
  {
    name: "total-exactly-at-warn",
    pins:
      "Total impact exactly at WARN_TOTAL_IMPACT warns. The boundary is " +
      "inclusive, and mutation testing found nothing pinned it — >= and > " +
      "behaved identically against the whole suite. One row, not two summing " +
      "to 0.3: 0.2 + 0.1 is 0.30000000000000004, which is already past the " +
      "boundary, so the first attempt at this case did not test it either.",
    rows: [row({ nodeId: 1, impact: 0.3 })],
  },
  {
    name: "total-just-below-warn",
    pins: "0.29 total stays APPROVE. Warning on everything is warning on nothing.",
    rows: [row({ nodeId: 1, impact: 0.15 }), row({ nodeId: 2, impact: 0.14 })],
  },
  {
    name: "sole-owner-warns-on-its-own",
    pins:
      "A trivial impact still warns when one person is the only one who can " +
      "explain it — that is the knowledge risk, not the blast radius.",
    rows: [row({ nodeId: 1, impact: 0.01, busFactor: 1 })],
  },
  {
    name: "block-wins-over-sole-owner",
    pins: "BLOCK short-circuits; it never degrades to WARN because of bus factor.",
    rows: [
      row({ nodeId: 1, impact: 0.95, minEdgeConfidence: 1 }),
      row({ nodeId: 2, impact: 0.02, busFactor: 1 }),
    ],
  },
  {
    name: "multiple-blocking-nodes-all-cited",
    pins: "Every blocking node appears in the evidence, not just the first.",
    rows: [
      row({ nodeId: 1, impact: 0.9, minEdgeConfidence: 1 }),
      row({ nodeId: 2, impact: 0.85, minEdgeConfidence: 1 }),
    ],
  },
  {
    name: "the-vat-rate-shape",
    pins:
      "The demo's signature case: one critical report one hop away over a " +
      "statically parsed edge. This is the verdict the pitch describes.",
    rows: [
      row({
        nodeId: 3,
        name: "public.eu_vat_report",
        kind: "report",
        impact: 1,
        criticality: 1,
        minEdgeConfidence: 1,
        pathConfidence: 1,
      }),
    ],
  },
];
