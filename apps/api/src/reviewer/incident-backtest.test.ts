import { describe, expect, it } from "vitest";
import { fixtureHash, type IncidentFixtures } from "./incident-backtest.js";

/**
 * The fixture hash is the only thing standing between an honest report and a
 * curated one, so it is worth testing that it actually notices curation.
 */

function fixtures(ids: string[], broke = true): IncidentFixtures {
  return {
    orgId: 1,
    labeledAt: "2026-07-26",
    labeledBy: "test",
    incidents: ids.map((id) => ({
      id,
      brokeSomething: broke,
      whatHappened: `${id} happened`,
      change: {
        target: "field",
        operation: "delete",
        connector: "postgres",
        externalId: `1/db/x/column/public.t.${id}`,
      },
    })),
  };
}

describe("fixtureHash", () => {
  it("is stable across reordering", () => {
    // Order is not content. A set that got shuffled by a tool is the same set,
    // and a hash that changed would cry wolf until people stopped reading it.
    expect(fixtureHash(fixtures(["a", "b", "c"]))).toBe(
      fixtureHash(fixtures(["c", "a", "b"])),
    );
  });

  it("changes when an inconvenient case is dropped", () => {
    // The property the whole mechanism exists for: rerun the backtest after
    // quietly removing the case that made the numbers bad, and the header no
    // longer matches the report you already sent.
    expect(fixtureHash(fixtures(["a", "b", "c"]))).not.toBe(
      fixtureHash(fixtures(["a", "b"])),
    );
  });

  it("changes when a label is flipped", () => {
    // Relabelling a miss as "did not break anything" is the other way to make
    // a hit rate look better.
    expect(fixtureHash(fixtures(["a", "b", "c"], true))).not.toBe(
      fixtureHash(fixtures(["a", "b", "c"], false)),
    );
  });

  it("ignores the narrative, which is prose and may be edited for clarity", () => {
    const a = fixtures(["a"]);
    const b = fixtures(["a"]);
    const first = b.incidents[0];
    if (first) first.whatHappened = "reworded by the partner before publication";
    expect(fixtureHash(a)).toBe(fixtureHash(b));
  });
});
