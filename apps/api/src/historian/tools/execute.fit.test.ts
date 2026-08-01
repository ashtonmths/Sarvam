import { describe, expect, it } from "vitest";
import { fitItems } from "./execute.js";

/**
 * The loop used to hand the model `JSON.stringify(output).slice(0, 4000)`.
 * These pin the two properties that cut got wrong: whole items survive, and a
 * thread keeps its ending rather than its beginning.
 */

const message = (index: number) => ({
  text: "x".repeat(400),
  author: `u${index}`,
  authored_at: null,
  permalink: `https://example.slack.com/archives/C1/p${index}`,
});

describe("fitItems", () => {
  it("keeps everything when it already fits", () => {
    const items = [message(1), message(2)];
    const { kept, dropped } = fitItems(items);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("drops whole items rather than cutting one in half", () => {
    const items = Array.from({ length: 40 }, (_, i) => message(i));
    const { kept, dropped } = fitItems(items);

    expect(kept.length).toBeLessThan(items.length);
    expect(dropped).toBe(items.length - kept.length);
    // Every survivor is intact — the failure being pinned is a fragment that
    // parses as complete.
    for (const item of kept) {
      expect(item.text).toHaveLength(400);
      expect(item.permalink).toMatch(/^https:/);
    }
    expect(() => JSON.parse(JSON.stringify(kept))).not.toThrow();
  });

  it("trims a thread from the front, because the decision is at the end", () => {
    const items = Array.from({ length: 40 }, (_, i) => message(i));
    const { kept } = fitItems(items, "front");

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)).toEqual(items.at(-1));
  });

  it("trims search results from the back, where relevance already ordered them", () => {
    const items = Array.from({ length: 40 }, (_, i) => message(i));
    const { kept } = fitItems(items);

    expect(kept[0]).toEqual(items[0]);
  });

  it("does not loop forever on a single oversized item", () => {
    const huge = { text: "x".repeat(50_000) };
    const { kept, dropped } = fitItems([huge]);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });
});
