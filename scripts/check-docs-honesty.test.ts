import { describe, expect, it } from "vitest";
import { findInText } from "./check-docs-honesty.js";

/**
 * A guard nobody tests is a guard that quietly stops matching. These assert
 * both directions, and the second matters more: a guard that fires on correct
 * documentation gets deleted within a week.
 */

describe("claims that must be caught", () => {
  it.each([
    "Reflex prevents destructive changes in Airtable.",
    "Our reflex mode blocks the delete before it lands.",
    "Sadhak prevents every breakage across your stack.",
    "We have prevented 400 incidents for our customers.",
    "42 outages prevented since launch.",
    "The AI decides the verdict for each change.",
    "The model determines the verdict in milliseconds.",
    "We read your data to build the map.",
  ])("flags: %s", (line) => {
    expect(findInText(line).length).toBeGreaterThan(0);
  });
});

describe("honest phrasings that must not be caught", () => {
  it.each([
    "Reflex compensates; it does not prevent.",
    "Reflex cannot prevent a change in the Airtable UI.",
    "Reflex detects the change and offers a one-click revert.",
    "No surface anywhere claims Reflex prevents changes.",
    "We do not claim to prevent every breakage.",
    "The verdict is arithmetic; no model decides it.",
    "The AI writes the explanation, it does not decide the verdict.",
    "Guessed edges can never block a merge — they can only warn.",
    "We never read your data, only your schema.",
    "Reverts executed and seconds-to-undone are the honest metrics.",
    "Sadhak blocks what can be blocked and makes the rest reversible.",
  ])("allows: %s", (line) => {
    expect(findInText(line)).toEqual([]);
  });
});

describe("reporting", () => {
  it("reports the line a claim appears on, not the file offset", () => {
    const text = ["# Title", "", "Reflex prevents everything.", ""].join("\n");

    const found = findInText(text);

    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  it("explains why each claim is refused, so the failure is actionable", () => {
    const found = findInText("Reflex prevents destructive changes.");

    expect(found[0]?.rule.why).toMatch(/compensates|does not prevent/i);
  });
});
