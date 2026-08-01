import { describe, expect, it } from "vitest";
import { toolArgSchemas } from "./defs.js";
import { executeTool } from "./execute.js";

/**
 * The punctuation bug, pinned.
 *
 * Nemotron ends every string it emits with a full stop, URLs and timestamps
 * included. Zod rejected the datetime, the citation check rejected the URL, and
 * the Historian burned its whole step budget failing to record an answer it had
 * already found — reported to the user as "no written trace found", which is
 * the most misleading outcome available.
 *
 * Asserted through executeTool rather than by exporting the normaliser, because
 * the property that matters is that a tool call with model punctuation gets
 * past validation. A unit test on a private helper would not have caught this,
 * since the helper did not exist.
 */
describe("tool arguments with model punctuation", () => {
  it("accepts a timestamp the model ended with a full stop", async () => {
    const result = await executeTool(
      "propose_rationale",
      {
        text: "the column is a historical record",
        author: "Lena Fischer.",
        confidence: 0.9,
        source_url: "http://localhost:3000/app/documents/1#chunk-3.",
        authored_at: "2026-03-12T14:00:00.000Z.",
      },
      { orgId: 1, edgeId: 1, seenUrls: new Set(), seenContent: new Map() },
    );

    // It still fails — nothing was searched, so nothing may be cited — but on
    // the citation rule rather than on a punctuation mark. Before the fix this
    // never got past "Invalid datetime".
    expect(JSON.stringify(result.output)).not.toContain("Invalid datetime");
    expect(JSON.stringify(result.output)).toContain("source_url returned to you");
  });

  /** Prose keeps its punctuation: a quote ending in a stop is a normal quote. */
  it("leaves prose fields alone", () => {
    const parsed = toolArgSchemas.give_up.safeParse({
      reason: "Nothing was written down.",
    });
    expect(parsed.success).toBe(true);
  });
});
