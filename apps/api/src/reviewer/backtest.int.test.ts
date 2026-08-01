import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, sql } from "../db.js";
import { backtest } from "./backtest.js";

/**
 * The backtest's value is entirely in what it refuses to say. A harness that
 * reported "100% agreement" over three rows would be worse than none: it reads
 * as validation and is arithmetic on noise.
 */

let orgId: number;

beforeEach(async () => {
  await sql`TRUNCATE organizations CASCADE`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('BT', 'bt-org') RETURNING id
  `;
  orgId = Number(org?.id);
});

afterAll(async () => {
  await closePools();
});

/** A stored decision: the verdict as recorded, plus the blast radius it saw. */
async function storedVerdict(recorded: string, impacted: unknown[]) {
  await sql`
    INSERT INTO verdicts (org_id, change, verdict, impacted)
    VALUES (${orgId}, ${JSON.stringify({ target: "field" })}::jsonb,
            ${recorded}, ${JSON.stringify(impacted)}::jsonb)
  `;
}

function blastRow(over: Record<string, unknown> = {}) {
  return {
    nodeId: 1,
    name: "n",
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

describe("with too little history", () => {
  it("reports no rate at all rather than a flattering one", async () => {
    await storedVerdict("BLOCK", [blastRow()]);
    await storedVerdict("BLOCK", [blastRow()]);

    const report = await backtest(orgId);

    expect(report.replayed).toBe(2);
    expect(report.agreed).toBe(2);
    // Two for two is 100%. Publishing that would be the single most misleading
    // number this harness could produce.
    expect(report.agreementRate).toBeNull();
    expect(report.note).toMatch(/floor for a rate worth quoting/i);
  });

  it("says nothing at all on an org with no decisions", async () => {
    const report = await backtest(orgId);

    expect(report.replayed).toBe(0);
    expect(report.agreementRate).toBeNull();
  });
});

describe("with enough history", () => {
  it("reports agreement once past the sample floor", async () => {
    for (let i = 0; i < 30; i++) await storedVerdict("BLOCK", [blastRow()]);

    const report = await backtest(orgId);

    expect(report.replayed).toBe(30);
    expect(report.agreementRate).toBe(1);
    expect(report.divergences).toEqual([]);
  });

  it("names every decision the current kernel would judge differently", async () => {
    for (let i = 0; i < 29; i++) await storedVerdict("BLOCK", [blastRow()]);
    // Recorded APPROVE, but this blast radius scores BLOCK today — either a
    // threshold moved without being written down, or a bug.
    await storedVerdict("APPROVE", [blastRow()]);

    const report = await backtest(orgId);

    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]?.storedVerdict).toBe("APPROVE");
    expect(report.divergences[0]?.recomputedVerdict).toBe("BLOCK");
    expect(report.agreementRate).toBeCloseTo(29 / 30, 5);
    expect(report.note).toMatch(/judged differently today/i);
  });
});

describe("what it replays", () => {
  it("uses the stored blast radius, not a fresh traversal", async () => {
    // The graph moves on. Re-traversing would compare today's dependencies
    // against yesterday's verdict and call the difference a regression, which
    // would make every backtest look worse the longer the product ran.
    await storedVerdict("APPROVE", []);

    const report = await backtest(orgId);

    expect(report.replayed).toBe(1);
    expect(report.agreed).toBe(1);
  });
});
