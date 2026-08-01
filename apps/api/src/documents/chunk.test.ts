import { describe, expect, it } from "vitest";
import { chunkDocument, estimateTokens, normalizeText } from "./chunk.js";

/**
 * The ceiling these pin is not stylistic: bge-small truncates at 512 tokens,
 * so a chunk over it is searchable by text its own vector never saw.
 */
const MAX_TOKENS = 450;

function transcript(turns: number): string {
  const speakers = ["Priya Raman", "Dan Okafor", "Mei Lin"];
  return Array.from({ length: turns }, (_, i) => {
    const speaker = speakers[i % speakers.length];
    return `${speaker}: ${"We discussed the billing migration in some detail. ".repeat(4)}`;
  }).join("\n\n");
}

describe("normalizeText", () => {
  it("strips a BOM and normalizes line endings so offsets stay honest", () => {
    expect(normalizeText("﻿a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("chunkDocument — sizing", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("   \n\n  \t ")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkDocument("We chose Postgres because the team already runs it.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.ordinal).toBe(0);
  });

  it("never exceeds the embedding ceiling", () => {
    const chunks = chunkDocument(transcript(60));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("numbers chunks contiguously from zero, since ordinal is the citation anchor", () => {
    const chunks = chunkDocument(transcript(40));
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("splits a single oversized paragraph rather than emitting one huge chunk", () => {
    const wall = "x".repeat(40_000);
    const chunks = chunkDocument(wall);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("terminates on text with no sentence punctuation at all", () => {
    const chunks = chunkDocument("word ".repeat(5000));
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("chunkDocument — boundaries", () => {
  it("does not cut a speaker turn in half", () => {
    const chunks = chunkDocument(transcript(60));
    for (const chunk of chunks) {
      // Every line that names a speaker must carry that speaker's words too,
      // never a bare dangling label left behind by a mid-turn cut.
      for (const line of chunk.body.split("\n")) {
        if (/^[A-Z][\w .'-]{0,48}:\s*$/.test(line)) {
          throw new Error(`chunk ${chunk.ordinal} ends on a bare speaker label`);
        }
      }
    }
  });

  it("attributes a chunk only when it is a single voice", () => {
    const single = chunkDocument("Priya Raman: We dropped vat_rate on purpose.");
    expect(single[0]?.speaker).toBe("Priya Raman");

    const mixed = chunkDocument(
      "Priya Raman: We dropped it.\n\nDan Okafor: Then the report broke.",
    );
    expect(mixed[0]?.speaker).toBeNull();
  });

  it("treats markdown headings as boundaries", () => {
    const chunks = chunkDocument(
      `# Decision\n\nWe keep the column.\n\n## Rejected\n\nDropping it broke the report.`,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.body).toContain("# Decision");
    expect(chunks[0]?.body).toContain("## Rejected");
  });
});

describe("chunkDocument — offsets", () => {
  it("produces offsets that index back into the original text", () => {
    const content = transcript(30);
    for (const chunk of chunkDocument(content)) {
      expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.endOffset).toBeLessThanOrEqual(content.length);
      expect(chunk.startOffset).toBeLessThan(chunk.endOffset);

      // The span the document page will highlight has to actually contain the
      // chunk's first words, or the highlight lands on unrelated text.
      const slice = content.slice(chunk.startOffset, chunk.endOffset);
      const firstWords = chunk.body.trim().split(/\s+/).slice(0, 4).join(" ");
      expect(slice).toContain(firstWords);
    }
  });
});

describe("chunkDocument — overlap", () => {
  it("repeats the seam so a passage spanning two chunks survives in one", () => {
    const chunks = chunkDocument(transcript(60));
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0];
    const second = chunks[1];
    if (!first || !second) throw new Error("expected at least two chunks");

    const tail = first.body.trim().split("\n").at(-1) ?? "";
    expect(second.body).toContain(tail.slice(0, 40));
  });

  it("does not emit a trailing chunk that is only the previous one's overlap", () => {
    const chunks = chunkDocument(transcript(60));
    const last = chunks.at(-1);
    const previous = chunks.at(-2);
    if (last && previous) expect(previous.body.includes(last.body)).toBe(false);
  });
});

describe("chunkDocument — subtitles", () => {
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Priya Raman: We dropped vat_rate because

2
00:00:04.000 --> 00:00:07.000
Priya Raman: the EU report computes it now.

3
00:00:07.500 --> 00:00:10.000
Dan Okafor: That is why the dashboard broke.
`;

  it("drops cue timings and keeps the words", () => {
    const chunks = chunkDocument(vtt);
    const body = chunks.map((c) => c.body).join("\n");
    expect(body).not.toMatch(/-->/);
    expect(body).not.toMatch(/WEBVTT/);
    expect(body).toContain("vat_rate");
  });

  it("merges consecutive cues from one speaker into a readable turn", () => {
    const body = chunkDocument(vtt)
      .map((c) => c.body)
      .join("\n");
    // Subtitle files break on reading speed, so one sentence spans cues.
    expect(body).toContain("We dropped vat_rate because the EU report computes it now.");
  });

  it("keeps a different speaker as its own unit", () => {
    const body = chunkDocument(vtt)
      .map((c) => c.body)
      .join("\n");
    expect(body).toContain("Dan Okafor: That is why the dashboard broke.");
  });
});

describe("estimateTokens", () => {
  it("stays conservative, so packing never sails past the model's limit", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
