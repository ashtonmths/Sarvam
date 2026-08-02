import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Slack retrieval path, which had no test at all.
 *
 * That absence is why it shipped broken. The agent evals exercise Slack, but
 * the fixture server answers `search.messages` with `not_allowed_token_type` to
 * force the bot fallback — so the user-token path, the one an OAuth-connected
 * workspace actually takes, ran for the first time in production and returned
 * an empty result to every question ever asked of it.
 *
 * Everything here is either pure or fetch-level. Nothing needs a database, a
 * Slack workspace or the embedding model, which is what keeps it in the tier
 * that runs on a fresh clone.
 */

/**
 * A stand-in for the local embedding model.
 *
 * Real vectors would mean a 130MB download inside a unit test. This keeps the
 * one property the ranking depends on — unit-length vectors whose dot product
 * rises with shared meaning — over a vocabulary small enough to reason about.
 */
const embedding = vi.hoisted(() => {
  const VOCAB = ["invoice", "deploy", "incident", "gst"];
  const vectorFor = (text: string): number[] => {
    const lower = text.toLowerCase();
    const raw: number[] = VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
    const magnitude = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
    return raw.map((v) => v / magnitude);
  };
  return {
    embed: vi.fn(async (text: string) => vectorFor(text)),
    embedAll: vi.fn(async (texts: string[]) => texts.map(vectorFor)),
  };
});

vi.mock("../../embed.js", () => embedding);

import {
  buildSearchQuery,
  contentTerms,
  lexicalScore,
  scanChannels,
  searchViaApi,
} from "./slack.js";

/* ------------------------------------------------------------------ *
 * Fetch stubbing
 * ------------------------------------------------------------------ */

type Body = Record<string, unknown>;

function ok(body: Body) {
  return { ok: true, json: async () => body };
}

/** Records every URL, so a test can assert on the query Slack was actually sent. */
function stubFetch(handler: (url: string) => Body) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return ok(handler(String(url)));
    }),
  );
  return calls;
}

/** The half of a `search.messages` match this code reads. */
function match(text: string, channel: { id: string; name: string }, ts = "1700000000.1") {
  return {
    text,
    username: "priya",
    ts,
    permalink: `https://acme.slack.com/archives/${channel.id}/p${ts.replace(".", "")}`,
    channel,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * Question -> terms
 * ------------------------------------------------------------------ */

describe("contentTerms", () => {
  /**
   * The defect in one line. Slack ANDs the words it is given, so a question
   * asked as a question demands one message containing every word of it —
   * including "did", "we" and "the" — and no such message has ever been sent.
   */
  it("drops the grammar a question is made of", () => {
    const terms = contentTerms("did we agree to drop the nightly reconciliation job?");
    expect(terms).not.toContain("did");
    expect(terms).not.toContain("we");
    expect(terms).not.toContain("the");
    expect(terms).toContain("reconciliation");
    expect(terms).toContain("nightly");
  });

  it("keeps a short token that is obviously an identifier", () => {
    const terms = contentTerms("is the n8n webhook on v2 yet?");
    expect(terms).toContain("n8n");
    expect(terms).toContain("v2");
    // Two letters and no digit is grammar, not a name.
    expect(terms).not.toContain("is");
  });

  it("keeps snake_case and dotted names whole", () => {
    expect(contentTerms("who owns billing.vat_rate?")).toContain("billing.vat_rate");
  });

  it("does not let trailing punctuation split a term in two", () => {
    const terms = contentTerms("did the deploy break? the deploy, again.");
    expect(terms.filter((term) => term === "deploy")).toHaveLength(1);
  });

  it("caps the term count so the tail does not widen the query into noise", () => {
    const terms = contentTerms(
      "invoice reconciliation dashboard migration webhook deployment incident postgres airtable rollout",
    );
    expect(terms.length).toBeLessThanOrEqual(8);
    // Longest first: specificity is what earns a slot.
    expect(terms).toContain("reconciliation");
  });

  it("never honors a channel qualifier the caller wrote", () => {
    expect(contentTerms("billing outage in:#exec from:@ceo")).toEqual(
      expect.not.arrayContaining(["exec", "ceo"]),
    );
  });
});

describe("buildSearchQuery", () => {
  it("ORs the terms, because ANDing them is the bug", () => {
    expect(buildSearchQuery("did the invoice import break?")).toBe(
      "invoice OR import OR break",
    );
  });

  /**
   * A question with no content words must not become an empty query. Slack
   * answers an empty query with recent messages, which would be presented as
   * search results and cited as evidence.
   */
  it("falls back to the question when nothing survives", () => {
    expect(buildSearchQuery("why is this?")).toBe("why is this?");
  });
});

describe("lexicalScore", () => {
  it("counts distinct terms so a message matching three beats one matching one", () => {
    expect(lexicalScore("the invoice deploy failed", ["invoice", "deploy", "gst"])).toBe(
      2,
    );
    expect(lexicalScore("the invoice failed", ["invoice", "deploy", "gst"])).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * search.messages
 * ------------------------------------------------------------------ */

const ENG = { id: "C0ENG", name: "eng" };
const OPS = { id: "C0OPS", name: "ops" };
const EXEC = { id: "C0EXEC", name: "exec" };

describe("searchViaApi", () => {
  /**
   * The regression this whole change exists for.
   *
   * `mining_scopes` stores channel ids and Slack's `in:` modifier resolves
   * channel names, so `in:C0ENG` was never a filter — it was one more word the
   * message had to contain, and no message contains it. Every question, on
   * every workspace, came back empty.
   */
  it("never sends a raw channel id to Slack as a qualifier", async () => {
    const calls = stubFetch(() => ({ ok: true, messages: { matches: [] } }));

    await searchViaApi(
      "xoxp-user",
      "did the invoice import break?",
      [ENG.id, OPS.id],
      new Map([
        [ENG.id, ENG.name],
        [OPS.id, OPS.name],
      ]),
    );

    const queries = calls.map((url) => decodeURIComponent(url));
    expect(queries[0]).toContain("in:#eng");
    expect(queries[0]).toContain("in:#ops");
    for (const query of queries) {
      expect(query).not.toContain("C0ENG");
      expect(query).not.toContain("C0OPS");
    }
  });

  it("groups the OR so it cannot bind to the channel qualifier", async () => {
    const calls = stubFetch(() => ({ ok: true, messages: { matches: [] } }));

    await searchViaApi(
      "xoxp-user",
      "invoice deploy",
      [ENG.id],
      new Map([[ENG.id, ENG.name]]),
    );

    expect(decodeURIComponent(calls[0] ?? "")).toContain("(invoice OR deploy) in:#eng");
  });

  /**
   * The qualifier is a courtesy to the workspace; the id check is the control.
   * Slack deciding a modifier means something else must not turn into Sadhak
   * reading a channel nobody consented to mine.
   */
  it("drops a match from a channel that is not in the mining scope", async () => {
    stubFetch(() => ({
      ok: true,
      messages: {
        matches: [
          match("invoice import died overnight", EXEC),
          match("invoice import is back up", ENG),
        ],
      },
    }));

    const result = await searchViaApi(
      "xoxp-user",
      "did the invoice import break?",
      [ENG.id],
      new Map([[ENG.id, ENG.name]]),
    );

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.text).toBe("invoice import is back up");
  });

  /**
   * Slack's parser is not something this code can assert against, so a thin
   * qualified result is retried without the qualifier and filtered here. That
   * retry is the difference between "the modifier was misread" and "the
   * workspace never discussed it", which otherwise look identical.
   */
  it("retries without the qualifier when the qualified attempt comes back thin", async () => {
    const calls = stubFetch((url) =>
      decodeURIComponent(url).includes("in:#eng")
        ? { ok: true, messages: { matches: [] } }
        : {
            ok: true,
            messages: {
              matches: [
                match("invoice run failed", ENG, "1700000001.1"),
                match("invoice retried fine", ENG, "1700000002.1"),
                match("invoice totals reconciled", ENG, "1700000003.1"),
              ],
            },
          },
    );

    const result = await searchViaApi(
      "xoxp-user",
      "did the invoice import break?",
      [ENG.id],
      new Map([[ENG.id, ENG.name]]),
    );

    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[1] ?? "")).not.toContain("in:#");
    expect(result.hits).toHaveLength(3);
  });

  it("searches unqualified when no channel name is known", async () => {
    const calls = stubFetch(() => ({
      ok: true,
      messages: { matches: [match("invoice import is back up", ENG)] },
    }));

    const result = await searchViaApi("xoxp-user", "invoice import", [ENG.id]);

    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0] ?? "")).not.toContain("in:#");
    expect(result.hits).toHaveLength(1);
  });

  /** Slack answers 200 with ok:false, which is otherwise an empty search. */
  it("reports a refusal rather than an absence", async () => {
    stubFetch(() => ({ ok: false, error: "missing_scope" }));

    const result = await searchViaApi("xoxp-user", "invoice import", [ENG.id]);

    expect(result.hits).toEqual([]);
    expect(result.unavailable).toContain("missing_scope");
  });

  it("ranks by meaning rather than by the order Slack returned", async () => {
    stubFetch(() => ({
      ok: true,
      messages: {
        matches: [
          match("deploy pipeline is green again", ENG, "1700000001.1"),
          match("the gst column landed", ENG, "1700000002.1"),
          match("invoice run died at 3am", ENG, "1700000003.1"),
        ],
      },
    }));

    const result = await searchViaApi("xoxp-user", "did the invoice run break?", [
      ENG.id,
    ]);

    expect(result.hits[0]?.text).toBe("invoice run died at 3am");
  });

  /**
   * The model is optional infrastructure. A cold cache or an unwritable volume
   * costs ranking quality, never the answer.
   */
  it("still answers when the embedding model cannot be loaded", async () => {
    embedding.embed.mockRejectedValueOnce(new Error("EACCES"));
    stubFetch(() => ({
      ok: true,
      messages: { matches: [match("invoice run died at 3am", ENG)] },
    }));

    const result = await searchViaApi("xoxp-user", "did the invoice run break?", [
      ENG.id,
    ]);

    expect(result.hits).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * conversations.history fallback
 * ------------------------------------------------------------------ */

function history(messages: Array<{ text: string; ts: string }>) {
  return {
    ok: true,
    messages: messages.map((m) => ({ text: m.text, user: "U1", ts: m.ts })),
  };
}

describe("scanChannels", () => {
  /**
   * The scan used to accept a message that shared *any* word with the question,
   * stopwords included — so "the" matched, and the ten most recent messages in
   * the first channel came back dressed as search results. A model handed those
   * answered from whatever they happened to say.
   */
  it("does not match a message on a stopword", async () => {
    stubFetch(() => history([{ text: "the standup is at ten", ts: "1700000001.1" }]));

    const result = await scanChannels("xoxb-bot", "what did we ship?", [ENG.id]);

    expect(result.hits).toEqual([]);
  });

  it("reads every channel before ranking, not the first ten matches", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("chat.getPermalink")) {
        return {
          ok: true,
          permalink: "https://acme.slack.com/archives/C0OPS/p17000000021",
        };
      }
      return url.includes(OPS.id)
        ? history([{ text: "the invoice run died at 3am", ts: "1700000002.1" }])
        : history([{ text: "deploy pipeline is green", ts: "1700000001.1" }]);
    });

    const result = await scanChannels("xoxb-bot", "did the invoice run break?", [
      ENG.id,
      OPS.id,
    ]);

    expect(calls.some((url) => url.includes(ENG.id))).toBe(true);
    expect(calls.some((url) => url.includes(OPS.id))).toBe(true);
    expect(result.hits[0]?.text).toBe("the invoice run died at 3am");
  });

  /**
   * A permalink is a request per message. Resolving one for every lexical match
   * spent a hundred calls against a rate limit to build a list that was then
   * cut to ten.
   */
  it("resolves permalinks only for what survives ranking", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      text: `invoice run note ${i}`,
      ts: `17000000${String(i).padStart(2, "0")}.1`,
    }));
    const calls = stubFetch((url) =>
      url.includes("chat.getPermalink")
        ? { ok: true, permalink: "https://acme.slack.com/archives/C0ENG/p17000000011" }
        : history(many),
    );

    await scanChannels("xoxb-bot", "invoice run", [ENG.id]);

    const permalinkCalls = calls.filter((url) => url.includes("chat.getPermalink"));
    expect(permalinkCalls.length).toBeLessThanOrEqual(10);
  });

  it("says so when every channel refuses", async () => {
    stubFetch(() => ({ ok: false, error: "not_in_channel" }));

    const result = await scanChannels("xoxb-bot", "invoice run", [ENG.id, OPS.id]);

    expect(result.hits).toEqual([]);
    expect(result.unavailable).toContain("not_in_channel");
    expect(result.unavailable).toContain("2");
  });
});
