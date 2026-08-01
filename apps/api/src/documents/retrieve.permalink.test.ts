import { describe, expect, it } from "vitest";
import { chunkPermalink, type DocumentHit, parseChunkPermalink } from "./retrieve.js";

/**
 * These two functions are the citation contract for uploaded evidence. If they
 * disagree, `urlInScope` rejects every document citation the Historian makes
 * and mining silently degrades to "no evidence found".
 */

describe("chunk permalinks", () => {
  it("round-trips a document and chunk id", () => {
    const url = chunkPermalink(42, 7);
    expect(parseChunkPermalink(url)).toEqual({ documentId: 42, ordinal: 7 });
  });

  it("round-trips chunk zero, which is falsy and easy to drop", () => {
    expect(parseChunkPermalink(chunkPermalink(1, 0))).toEqual({
      documentId: 1,
      ordinal: 0,
    });
  });

  it("carries the anchor the document page scrolls to", () => {
    expect(chunkPermalink(42, 7)).toMatch(/\/app\/documents\/42#chunk-7$/);
  });

  it("rejects a url that is not a document citation", () => {
    for (const url of [
      "https://acme.slack.com/archives/C01ABC/p1700000000000100",
      "https://github.com/acme/api/pull/12",
      "https://example.com/app/documents/42",
      "https://example.com/app/documents/abc#chunk-1",
      "https://example.com/app/documents/42#chunk-x",
      "",
    ]) {
      expect(parseChunkPermalink(url)).toBeNull();
    }
  });

  /**
   * A trailing-garbage url must not parse, or a crafted citation could claim
   * to belong to a document it does not.
   */
  it("anchors at the end of the string", () => {
    expect(
      parseChunkPermalink("https://example.com/app/documents/42#chunk-7/../../99"),
    ).toBeNull();
  });
});

/**
 * The type said Date, the driver returned a string, and `as unknown as` let the
 * compiler believe the type. Nothing failed at build; the first caller to call
 * .toISOString() on it got a 500 in the browser instead.
 *
 * Asserted through the exported hit shape rather than by unit-testing the
 * private coercion, because the contract that matters is "DocumentHit.occurredAt
 * is a Date" — that is what callers rely on and what silently was not true.
 */
describe("DocumentHit.occurredAt", () => {
  it("is a real Date, so callers can format it", () => {
    const hit: DocumentHit = {
      documentId: 1,
      chunkOrdinal: 0,
      title: "t",
      body: "b",
      speaker: null,
      occurredAt: new Date("2026-03-12T14:00:00Z"),
      permalink: "x",
      score: 1,
    };
    expect(() => hit.occurredAt?.toISOString()).not.toThrow();
    expect(hit.occurredAt?.toISOString()).toBe("2026-03-12T14:00:00.000Z");
  });
});
