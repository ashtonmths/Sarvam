import { describe, expect, it } from "vitest";
import { MAX_EMBED_CHARS, meanNormalized, windowsOf } from "./embed.js";

/**
 * The bug these pin is invisible from the outside: `bge-small-en` truncates at
 * 512 tokens with `truncation: true` hard-coded, so a long rationale produced a
 * perfectly normal-looking vector that simply did not represent its own ending.
 * Nothing errors, nothing logs, and the text is just quietly unfindable.
 */

describe("windowsOf", () => {
  it("leaves a short text alone", () => {
    expect(windowsOf("we dropped vat_rate")).toEqual(["we dropped vat_rate"]);
  });

  it("never emits a window the model would truncate", () => {
    for (const length of [MAX_EMBED_CHARS + 1, 4000, 12_000]) {
      for (const window of windowsOf("x".repeat(length))) {
        expect(window.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
      }
    }
  });

  it("covers the whole text, including the end", () => {
    // The conclusion is the part worth finding, and plain truncation is
    // precisely what loses it.
    const text = `${"a".repeat(4000)}THE-DECISION`;
    expect(windowsOf(text).some((w) => w.includes("THE-DECISION"))).toBe(true);
  });

  it("overlaps, so a sentence spanning a seam survives whole somewhere", () => {
    const windows = windowsOf("x".repeat(4000));
    expect(windows.length).toBeGreaterThan(1);

    const first = windows[0];
    const second = windows[1];
    if (!first || !second) throw new Error("expected two windows");
    // Stride is shorter than the window, which is what the overlap means.
    expect(windows.length * MAX_EMBED_CHARS).toBeGreaterThan(4000);
  });

  it("terminates on a text that is an exact multiple of the window", () => {
    expect(windowsOf("x".repeat(MAX_EMBED_CHARS * 3)).length).toBeLessThan(10);
  });
});

describe("meanNormalized", () => {
  it("returns a single vector unchanged", () => {
    expect(meanNormalized([[0.6, 0.8]])).toEqual([0.6, 0.8]);
  });

  it("produces a unit vector, so cosine distance stays comparable", () => {
    const merged = meanNormalized([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const magnitude = Math.sqrt(merged.reduce((acc, v) => acc + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it("points between its inputs rather than at one of them", () => {
    const [x, y] = meanNormalized([
      [1, 0],
      [0, 1],
    ]);
    expect(x).toBeCloseTo(y as number, 6);
  });

  it("survives an empty input rather than returning NaN", () => {
    expect(meanNormalized([])).toEqual([]);
  });
});
