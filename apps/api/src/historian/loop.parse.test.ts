import { describe, expect, it } from "vitest";
import { parseCall } from "./loop.js";

/**
 * Free models are small models, and providers rotate and re-serve them, so
 * `response_format` can silently degrade to plain text. `parseCall` is the
 * floor: if it cannot recover a call, the loop takes a repair turn and then
 * gives up — it never invents one.
 */

describe("structured-output envelope", () => {
  it("reads a clean envelope", () => {
    const call = parseCall({
      content: '{"tool":"search_slack","args":{"query":"vat_rate"}}',
      toolCalls: [],
    });
    expect(call).toMatchObject({ tool: "search_slack", args: { query: "vat_rate" } });
  });

  it("recovers an envelope wrapped in code fences", () => {
    const call = parseCall({
      content: '```json\n{"tool":"give_up","args":{"reason":"no trace"}}\n```',
      toolCalls: [],
    });
    expect(call?.tool).toBe("give_up");
  });

  it("recovers an envelope followed by chatty prose", () => {
    const call = parseCall({
      content:
        '{"tool":"get_edge_context","args":{}} — let me start by looking at the edge.',
      toolCalls: [],
    });
    expect(call?.tool).toBe("get_edge_context");
  });

  it("handles a brace inside a string without ending the object early", () => {
    const call = parseCall({
      content: '{"tool":"search_slack","args":{"query":"why is {vat_rate} here"}}',
      toolCalls: [],
    });
    expect(call?.args).toEqual({ query: "why is {vat_rate} here" });
  });

  it("falls back to a native tool call when there is no envelope", () => {
    const call = parseCall({
      content: null,
      toolCalls: [
        {
          id: "call_1",
          function: { name: "search_github", arguments: '{"query":"vat"}' },
        },
      ],
    });
    expect(call).toMatchObject({ tool: "search_github", args: { query: "vat" } });
  });
});

describe("unparseable output stays unparseable", () => {
  it("returns null on prose with no JSON at all", () => {
    expect(
      parseCall({ content: "I think this is about VAT reporting.", toolCalls: [] }),
    ).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(
      parseCall({ content: '{"tool": "search_slack", "args"', toolCalls: [] }),
    ).toBeNull();
  });

  it("returns null when the envelope has no tool", () => {
    expect(parseCall({ content: '{"args":{"query":"x"}}', toolCalls: [] })).toBeNull();
  });

  it("returns null on empty content and no tool calls", () => {
    expect(parseCall({ content: null, toolCalls: [] })).toBeNull();
    expect(parseCall({ content: "", toolCalls: [] })).toBeNull();
  });

  it("never fabricates a propose_rationale from garbage", () => {
    // The whole point of give_up as a first-class terminal: a confused model
    // takes the honourable exit instead of confabulating. There is no path
    // from an unparseable response to a proposed rationale.
    for (const garbage of ["", "???", "propose_rationale", '{"tool":}', "null"]) {
      const call = parseCall({ content: garbage, toolCalls: [] });
      expect(call?.tool).not.toBe("propose_rationale");
    }
  });
});
