import { describe, expect, it } from "vitest";
import { type CheckpointRow, FALLBACK_LOOKBACK_MS, windowsFrom } from "./checkpoints.js";
import { rank, type Signals, summarize, usefulTerms } from "./investigate.js";
import type { ChangeRow } from "./store.js";

const INCIDENT = new Date("2026-03-12T18:00:00Z");

function change(over: Partial<ChangeRow> & { id: number }): ChangeRow {
  return {
    kind: "commit",
    externalId: `sha${over.id}`,
    title: "chore: tidy",
    body: null,
    authorLogin: "someone",
    occurredAt: new Date("2026-03-12T17:00:00Z"),
    url: `https://github.com/acme/api/commit/sha${over.id}`,
    ...over,
  };
}

function checkpoint(over: Partial<CheckpointRow> & { id: number }): CheckpointRow {
  return {
    kind: "manual",
    label: `checkpoint ${over.id}`,
    confidence: 0.9,
    occurredAt: new Date("2026-03-12T12:00:00Z"),
    repoId: null,
    nodeId: null,
    environment: null,
    sourceUrl: null,
    ...over,
  };
}

const signals: Signals = { terms: ["vat_rate", "invoices"], pathHints: ["billing/"] };

describe("rank", () => {
  it("puts a change that touched a matching path above one that only mentions it", () => {
    const mentions = change({ id: 1, title: "docs: explain vat_rate handling" });
    const touched = change({ id: 2, title: "chore: tidy" });

    const scored = rank(
      [mentions, touched],
      new Map([[2, ["src/billing/invoices.ts"]]]),
      signals,
      INCIDENT,
    );

    // A commit that edited the file is a fact; one that names it may only be
    // referring to it.
    expect(scored[0]?.change.id).toBe(2);
  });

  it("explains why every candidate surfaced", () => {
    const scored = rank(
      [change({ id: 1, title: "fix: drop vat_rate" })],
      new Map(),
      signals,
      INCIDENT,
    );
    expect(scored[0]?.why.join(" ")).toContain("vat_rate");
  });

  it("does not let recency lift an unrelated change above a matching one", () => {
    const unrelatedButRecent = change({
      id: 1,
      title: "chore: bump lockfile",
      occurredAt: new Date("2026-03-12T17:59:00Z"),
    });
    const relatedButOlder = change({
      id: 2,
      title: "fix: recompute vat_rate in the EU report",
      occurredAt: new Date("2026-03-11T09:00:00Z"),
    });

    const scored = rank(
      [unrelatedButRecent, relatedButOlder],
      new Map(),
      signals,
      INCIDENT,
    );
    expect(scored[0]?.change.id).toBe(2);
  });

  it("ignores terms too short to discriminate", () => {
    const scored = rank(
      [change({ id: 1, title: "a b c" })],
      new Map(),
      { terms: ["a", "b"] },
      INCIDENT,
    );
    // Only the proximity tiebreak should have contributed.
    expect(scored[0]?.score).toBeLessThan(0.2);
  });

  it("is deterministic when two changes score the same", () => {
    const older = change({ id: 1, occurredAt: new Date("2026-03-12T10:00:00Z") });
    const newer = change({ id: 2, occurredAt: new Date("2026-03-12T16:00:00Z") });
    const scored = rank([older, newer], new Map(), { terms: [] }, INCIDENT);
    expect(scored.map((s) => s.change.id)).toEqual([2, 1]);
  });

  it("never exceeds a score of one", () => {
    const everything = change({
      id: 1,
      title: "vat_rate invoices vat_rate invoices",
      body: "vat_rate invoices",
      occurredAt: new Date("2026-03-12T17:59:00Z"),
    });
    const paths = new Map([
      [1, ["src/billing/invoices.ts", "src/billing/vat_rate.ts", "billing/tax.ts"]],
    ]);
    expect(rank([everything], paths, signals, INCIDENT)[0]?.score).toBeLessThanOrEqual(1);
  });
});

describe("summarize", () => {
  /**
   * The shipped bug this pins: `likelyCause` was the internal `ScoredChange`,
   * which nests the commit under `.change`, while the rounds were flattened
   * separately. A client reading `likelyCause.externalId` got undefined — and
   * only when the search succeeded, so the failure appeared exactly on the
   * path a demo takes and never on an empty one.
   */
  const investigation = {
    incidentAt: INCIDENT,
    stoppedBecause: "found" as const,
    caveat: null,
    rounds: [],
    conclusion: {
      window: {
        from: new Date("2026-03-12T12:00:00Z"),
        to: INCIDENT,
        checkpoint: checkpoint({ id: 1 }),
        reason: "since manual",
      },
      totalInWindow: 2,
      truncated: false,
      confidence: 0.8,
      candidates: [
        {
          change: change({ id: 1, title: "fix: vat_rate" }),
          paths: ["src/billing/invoices.ts"],
          score: 0.8,
          why: ["touched src/billing/invoices.ts"],
        },
        {
          change: change({ id: 2, title: "chore: tidy" }),
          paths: [],
          score: 0.1,
          why: [],
        },
      ],
    },
  };

  it("flattens the commit onto the candidate rather than nesting it", () => {
    const summary = summarize(investigation);
    expect(summary.likelyCause?.externalId).toBe("sha1");
    expect(summary.likelyCause?.title).toBe("fix: vat_rate");
    expect(summary.likelyCause?.url).toContain("github.com");
    // `author` is the flattened name for the commit's authorLogin.
    expect(summary.likelyCause?.author).toBe("someone");
    expect(summary.likelyCause).not.toHaveProperty("change");
  });

  it("uses the same shape for supporting candidates", () => {
    const [supporting] = summarize(investigation).supporting;
    expect(supporting?.externalId).toBe("sha2");
    expect(supporting).not.toHaveProperty("change");
  });

  it("returns null rather than a half-built candidate when nothing was found", () => {
    const summary = summarize({
      ...investigation,
      conclusion: null,
      stoppedBecause: "no_changes",
    });
    expect(summary.likelyCause).toBeNull();
    expect(summary.supporting).toEqual([]);
    expect(summary.confidence).toBe(0);
  });
});

describe("usefulTerms", () => {
  /**
   * The bug: a bare length filter let "the api is down" through as three
   * terms, and every commit under apps/api/ matched on paths — which score
   * higher than prose — plus a title word plus proximity, for 0.85. That
   * cleared the confidence target, so the search reported `found` with no
   * caveat and named the most recent commit in the language of evidence.
   */
  it("drops filler, incident vocabulary and structural path words", () => {
    expect(usefulTerms(["the", "api", "is", "down"])).toEqual([]);
    expect(usefulTerms(["src", "lib", "app", "web", "test"])).toEqual([]);
    expect(usefulTerms(["prod", "outage", "broken", "service"])).toEqual([]);
  });

  it("keeps the words that actually identify something", () => {
    expect(usefulTerms(["eu_vat_report", "is", "empty"])).toEqual(["eu_vat_report"]);
    expect(usefulTerms(["invoices", "vat_rate"])).toEqual(["invoices", "vat_rate"]);
  });

  it("strips punctuation the splitter leaves behind", () => {
    expect(usefulTerms(["vat_rate.", "(invoices)"])).toEqual(["vat_rate", "invoices"]);
  });

  it("deduplicates, so repetition cannot inflate a score", () => {
    expect(usefulTerms(["invoices", "Invoices", "INVOICES"])).toEqual(["invoices"]);
  });

  it("leaves a symptom of nothing but stopwords with no terms at all", () => {
    // Better to score nothing than to score everything equally.
    const scored = rank(
      [change({ id: 1, title: "chore: bump deps" })],
      new Map([[1, ["apps/api/src/index.ts"]]]),
      { terms: usefulTerms(["the", "api", "is", "down"]) },
      INCIDENT,
    );
    expect(scored[0]?.score).toBeLessThan(0.2);
  });
});

describe("windowsFrom", () => {
  it("widens with each successive window, all ending at the incident", () => {
    const windows = windowsFrom(
      [
        checkpoint({ id: 1, occurredAt: new Date("2026-03-12T17:00:00Z") }),
        checkpoint({ id: 2, occurredAt: new Date("2026-03-12T09:00:00Z") }),
        checkpoint({ id: 3, occurredAt: new Date("2026-03-10T09:00:00Z") }),
      ],
      INCIDENT,
      3,
    );

    expect(windows).toHaveLength(3);
    for (const w of windows) expect(w.to).toEqual(INCIDENT);

    // Each window must start strictly earlier than the one before it, or a
    // round would re-search what the previous round already rejected.
    for (let i = 1; i < windows.length; i += 1) {
      const previous = windows[i - 1];
      const current = windows[i];
      if (!previous || !current) throw new Error("expected windows");
      expect(current.from.getTime()).toBeLessThan(previous.from.getTime());
    }
  });

  it("falls back to a fixed lookback when nothing has been checkpointed", () => {
    const [only] = windowsFrom([], INCIDENT, 4);
    if (!only) throw new Error("expected a fallback window");

    expect(only.checkpoint).toBeNull();
    expect(only.from).toEqual(new Date(INCIDENT.getTime() - FALLBACK_LOOKBACK_MS));
    // The report has to admit it was searching blind rather than implying a
    // known-good starting point.
    expect(only.reason).toMatch(/no checkpoint/i);
  });

  /**
   * maxWindows of 1 is valid input the API accepts. The ladder arithmetic
   * divided by (maxWindows - 1), so it produced NaN, no windows, and an
   * investigation that reported "nothing shipped" having searched nothing.
   */
  it("returns one window when only one is asked for", () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      checkpoint({
        id: i,
        occurredAt: new Date(INCIDENT.getTime() - (i + 1) * 3_600_000),
      }),
    );
    const windows = windowsFrom(pool, INCIDENT, 1);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.checkpoint?.id).toBe(0);
  });

  it("never returns an empty ladder for a non-empty pool", () => {
    const pool = Array.from({ length: 7 }, (_, i) => checkpoint({ id: i }));
    for (const max of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(windowsFrom(pool, INCIDENT, max).length).toBeGreaterThan(0);
    }
  });

  it("respects the window cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      checkpoint({
        id: i,
        occurredAt: new Date(INCIDENT.getTime() - (i + 1) * 3_600_000),
      }),
    );
    expect(windowsFrom(many, INCIDENT, 3)).toHaveLength(3);
  });

  /**
   * With more candidates than windows, taking the newest N gave a ladder whose
   * widest rung was still recent — on a deployment writing a crawl_healthy
   * checkpoint every hour, four windows spanning a couple of hours. Widening
   * has to actually widen.
   */
  it("spreads the ladder across the pool and always ends at the oldest", () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      checkpoint({
        id: i,
        occurredAt: new Date(INCIDENT.getTime() - (i + 1) * 3_600_000),
      }),
    );
    const windows = windowsFrom(pool, INCIDENT, 4);

    expect(windows).toHaveLength(4);
    // The final round must be the broadest search available, not the fourth
    // narrowest, or the caveat about having searched everything is a lie.
    expect(windows.at(-1)?.checkpoint?.id).toBe(19);
    expect(windows[0]?.checkpoint?.id).toBe(0);
  });

  it("starts from the most recent checkpoint regardless of input order", () => {
    const recent = checkpoint({ id: 1, occurredAt: new Date("2026-03-12T17:00:00Z") });
    const old = checkpoint({ id: 2, occurredAt: new Date("2026-03-01T17:00:00Z") });
    const [first] = windowsFrom([old, recent], INCIDENT, 2);
    expect(first?.checkpoint?.id).toBe(1);
  });
});
