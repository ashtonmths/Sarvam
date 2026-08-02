import { describe, expect, it, vi } from "vitest";

/**
 * The prose an agent actually reads.
 *
 * Everything here is the wording, which is the part of this tool that failed
 * hardest: a workspace with every channel connected asked four questions, got
 * four empty answers, and the sentence it got back sent the reader to check a
 * setting that was already correct. A retrieval bug costs an answer; a sentence
 * that misdescribes the retrieval costs the next hour.
 */

// The module graph reaches the local embedding model. Loading it to assert on
// a string would put a 130MB download in the no-services test tier.
vi.mock("../embed.js", () => ({
  embed: vi.fn(async () => []),
  embedAll: vi.fn(async () => []),
}));

import { nothingFound, renderAskSlackText, splitSections } from "./slack.js";

describe("nothingFound", () => {
  /**
   * The two states that were one sentence. An admin who has connected twenty
   * channels must not be told to go and connect channels.
   */
  it("says nothing was searched when no channel is connected", () => {
    const text = nothingFound(0);
    expect(text).toContain("No Slack channel is connected");
    expect(text).toContain("connector settings");
    // The absence of evidence must not read as evidence of absence.
    expect(text).toContain("not evidence");
  });

  it("says what was searched when channels are connected", () => {
    const text = nothingFound(12);
    expect(text).toContain("12 Slack channels");
    expect(text).not.toContain("No Slack channel is connected");
  });

  it("does not pluralise a single channel", () => {
    expect(nothingFound(1)).toContain("1 Slack channel this");
  });

  /** A rejected search is not a search that looked at zero channels. */
  it("claims nothing about scope when the search itself failed", () => {
    const text = nothingFound(-1);
    expect(text).toContain("could not be searched");
    expect(text).not.toContain("No Slack channel is connected");
  });
});

describe("renderAskSlackText", () => {
  const empty = {
    answer: nothingFound(9),
    reasoning: null,
    unavailable: null,
    sources: [],
    notes: ["Slack search returned HTTP 429."],
  };

  it("heads the caveats without claiming the search never ran", () => {
    const text = renderAskSlackText(empty, "did we ship the invoice import?");
    expect(text).toContain("Caveats on what was searched:");
    expect(text).not.toContain("Why there was nothing to search");
    expect(text).toContain("HTTP 429");
  });

  it("keeps every permalink, whether or not the model cited it", () => {
    const text = renderAskSlackText(
      {
        answer: "The nightly job was dropped in July. [1]",
        reasoning: "Two people agreed and nobody objected.",
        unavailable: null,
        sources: [
          {
            n: 1,
            kind: "message",
            author: "priya",
            permalink: "https://acme.slack.com/archives/C0ENG/p1700000001",
            occurred_at: "2026-07-02T09:00:00.000Z",
            excerpt: "dropping the nightly reconciliation",
          },
          {
            n: 2,
            kind: "thread_reply",
            author: "sam",
            permalink: "https://acme.slack.com/archives/C0ENG/p1700000002",
            occurred_at: null,
            excerpt: "agreed, it has not caught anything in months",
          },
        ],
        notes: [],
      },
      "did we drop the nightly job?",
    );

    expect(text).toContain("p1700000001");
    expect(text).toContain("p1700000002");
    expect(text).toContain("reply in thread");
    expect(text).toContain("undated");
    expect(text).toContain("How this was reached:");
  });

  /**
   * With no model, the messages are still the valuable part — and the agent has
   * to be told not to fill the gap from memory, which is exactly what it does
   * when it reads a tool result as a failure.
   */
  it("tells the agent not to answer from its own knowledge when the model is off", () => {
    const text = renderAskSlackText(
      {
        answer: "",
        reasoning: null,
        unavailable: "The model is switched off for this deployment.",
        sources: [
          {
            n: 1,
            kind: "message",
            author: "priya",
            permalink: "https://acme.slack.com/archives/C0ENG/p1700000001",
            occurred_at: "2026-07-02T09:00:00.000Z",
            excerpt: "dropping the nightly reconciliation",
          },
        ],
        notes: [],
      },
      "did we drop the nightly job?",
    );

    expect(text).toContain("Do not answer");
    expect(text).toContain("from your own knowledge");
  });
});

describe("splitSections", () => {
  it("splits the two headings", () => {
    const { answer, reasoning } = splitSections(
      "ANSWER:\nWe dropped it. [1]\n\nREASONING:\nPriya proposed, Sam agreed.",
    );
    expect(answer).toBe("We dropped it. [1]");
    expect(reasoning).toBe("Priya proposed, Sam agreed.");
  });

  /**
   * A model that ignores the format has still answered the question. Failing
   * the call over a missing heading throws away a good answer to enforce a
   * layout.
   */
  it("keeps an unformatted answer rather than discarding it", () => {
    expect(splitSections("We dropped it in July.")).toEqual({
      answer: "We dropped it in July.",
      reasoning: null,
    });
  });

  it("handles an answer heading with no reasoning section", () => {
    expect(splitSections("ANSWER:\nWe dropped it.")).toEqual({
      answer: "We dropped it.",
      reasoning: null,
    });
  });
});
