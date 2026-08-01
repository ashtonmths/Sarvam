import { describe, expect, it } from "vitest";
import { type ConcentrationSignals, concentration } from "./concentration.js";

/**
 * The failure this replaces is a confident "bus factor: 1" derived from the
 * fact that one person wrote the Slack message we happened to index. So the
 * tests lean on the two ways that goes wrong: calling absence of evidence a
 * risk, and treating one human as several because their identity is spelled
 * differently in different systems.
 */

function signals(over: Partial<Record<keyof ConcentrationSignals, string[]>> = {}) {
  return {
    rationaleAuthors: new Set(over.rationaleAuthors ?? []),
    artifactAuthors: new Set(over.artifactAuthors ?? []),
    interactors: new Set(over.interactors ?? []),
  };
}

describe("absence of evidence", () => {
  it("is unknown, never high", () => {
    // An unmined node looks identical to a genuinely single-owner one.
    // Reporting the scary answer for "we have not looked yet" is how a risk
    // list trains people to ignore it.
    const result = concentration(signals());

    expect(result.band).toBe("unknown");
    expect(result.reason).toMatch(/nothing has been mined/i);
  });

  it("says so plainly rather than reporting zero people as a finding", () => {
    expect(concentration(signals()).distinctPeople).toBe(0);
  });
});

describe("banding", () => {
  it("calls one person high concentration risk", () => {
    const result = concentration(signals({ rationaleAuthors: ["priya"] }));

    expect(result.band).toBe("high");
    expect(result.distinctPeople).toBe(1);
  });

  it("flags a single-signal finding as a lead rather than a conclusion", () => {
    const result = concentration(signals({ rationaleAuthors: ["priya"] }));

    expect(result.signalsPresent).toBe(1);
    expect(result.reason).toMatch(/lead, not a finding/i);
  });

  it("is more confident when several kinds of evidence agree", () => {
    const result = concentration(
      signals({
        rationaleAuthors: ["priya"],
        artifactAuthors: ["priya"],
        interactors: ["priya"],
      }),
    );

    expect(result.band).toBe("high");
    expect(result.signalsPresent).toBe(3);
    expect(result.reason).not.toMatch(/lead, not a finding/i);
  });

  it.each([
    [["a", "b"], "medium"],
    [["a", "b", "c"], "low"],
    [["a", "b", "c", "d"], "low"],
  ])("bands %j as %s", (people, band) => {
    expect(concentration(signals({ rationaleAuthors: people })).band).toBe(band);
  });
});

describe("identity", () => {
  it("does not count one human twice for writing their address differently", () => {
    // Counting Priya once as a commit author and again as a confirmer would
    // halve the apparent risk on exactly the nodes that matter most.
    const result = concentration(
      signals({
        rationaleAuthors: ["Priya@Example.com"],
        artifactAuthors: ["priya@example.com"],
        interactors: [" priya@example.com "],
      }),
    );

    expect(result.distinctPeople).toBe(1);
    expect(result.band).toBe("high");
  });

  it("ignores empty and whitespace identities rather than counting them", () => {
    const result = concentration(signals({ rationaleAuthors: ["priya", "", "   "] }));

    expect(result.distinctPeople).toBe(1);
  });

  it("counts across signals, so three signals naming three people is low risk", () => {
    const result = concentration(
      signals({
        rationaleAuthors: ["priya"],
        artifactAuthors: ["sam"],
        interactors: ["alex"],
      }),
    );

    expect(result.distinctPeople).toBe(3);
    expect(result.band).toBe("low");
  });
});

describe("human override", () => {
  it("wins over every computed signal", () => {
    // A person who looked beats three proxies. These corrections are the
    // compounding asset nobody can reconstruct by crawling.
    const result = concentration(signals({ rationaleAuthors: ["a", "b", "c", "d"] }), {
      band: "high",
      reason: "only Priya has ever actually run this",
      by: "sam@x.com",
    });

    expect(result.band).toBe("high");
  });

  it("records who overrode it and why, so the band is never bare", () => {
    const result = concentration(signals({ rationaleAuthors: ["a"] }), {
      band: "low",
      reason: "whole team rebuilt this last quarter",
      by: "sam@x.com",
    });

    expect(result.band).toBe("low");
    expect(result.reason).toContain("sam@x.com");
    expect(result.reason).toContain("whole team rebuilt this");
  });

  it("still reports what the signals said, so the override is auditable", () => {
    const result = concentration(signals({ rationaleAuthors: ["a", "b", "c"] }), {
      band: "high",
      reason: "the others only reviewed it",
      by: "sam@x.com",
    });

    expect(result.distinctPeople).toBe(3);
  });
});

describe("every band carries its reason", () => {
  it.each([
    signals(),
    signals({ rationaleAuthors: ["a"] }),
    signals({ rationaleAuthors: ["a", "b"] }),
    signals({ rationaleAuthors: ["a", "b", "c"] }),
  ])("never returns a band without an explanation", (input) => {
    // A band on a dashboard with no sentence beside it becomes a number people
    // quote, which is the exact failure this module exists to prevent.
    expect(concentration(input).reason.length).toBeGreaterThan(20);
  });
});
