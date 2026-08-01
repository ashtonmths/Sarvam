import { describe, expect, it } from "vitest";
import { parseJudgment } from "./triage.js";

/**
 * The parser is the safety boundary. A dismissal mutes a signature for 30
 * days, so anything it accepts becomes real authority — and the failure that
 * matters is accepting garbage as a `benign`, which hides a live breakage
 * behind a mute nobody chose.
 *
 * Returning null is always safe: the caller stamps budget_exhausted_at and
 * leaves the finding open for a human. So these tests lean hard on refusing
 * ambiguity rather than on being generous.
 */

describe("accepts a well-formed judgment", () => {
  it.each(["benign", "real", "unsure"] as const)("parses decision=%s", (decision) => {
    const parsed = parseJudgment(`{"decision":"${decision}","reason":"a clear reason"}`);

    expect(parsed).toEqual({ decision, reason: "a clear reason" });
  });

  it("unwraps a fenced code block", () => {
    const raw = '```json\n{"decision":"real","reason":"a column was removed"}\n```';

    expect(parseJudgment(raw)?.decision).toBe("real");
  });

  it("finds the object inside surrounding prose", () => {
    // Free models frequently narrate before answering.
    const raw = 'Here is my answer:\n{"decision":"unsure","reason":"not enough context"}';

    expect(parseJudgment(raw)?.decision).toBe("unsure");
  });

  it("trims and caps an overlong reason", () => {
    const raw = `{"decision":"real","reason":"  ${"x".repeat(900)}  "}`;

    expect(parseJudgment(raw)?.reason.length).toBe(500);
  });
});

describe("refuses anything ambiguous", () => {
  it.each([
    ["null input", null],
    ["empty string", ""],
    ["prose with no object", "I think this one is probably fine, honestly."],
    ["not json", "{decision: benign}"],
    ["truncated json", '{"decision":"benign","reason":"looks fi'],
    ["missing reason", '{"decision":"benign"}'],
    ["empty reason", '{"decision":"benign","reason":""}'],
    ["whitespace reason", '{"decision":"benign","reason":"   "}'],
    ["reason too short to be one", '{"decision":"benign","reason":"ok"}'],
    ["unknown decision", '{"decision":"probably-fine","reason":"a reason here"}'],
    ["decision not a string", '{"decision":true,"reason":"a reason here"}'],
    ["reason not a string", '{"decision":"benign","reason":42}'],
    ["a bare string", '"benign"'],
    // Two judgments is genuinely ambiguous — there is no way to know which one
    // the model meant, so it must fail closed rather than pick the first.
    [
      "two judgments",
      '[{"decision":"benign","reason":"a reason here"},{"decision":"real","reason":"another"}]',
    ],
  ])("returns null for %s", (_label, raw) => {
    expect(parseJudgment(raw)).toBeNull();
  });

  it("accepts a single judgment wrapped in an array", () => {
    // Not ambiguity: there is exactly one judgment, and a model that wrapped
    // it is the same case as one that narrated before it.
    const parsed = parseJudgment('[{"decision":"real","reason":"a column went away"}]');

    expect(parsed?.decision).toBe("real");
  });

  it("does not coerce a near-miss decision into benign", () => {
    // The dangerous direction: anything that is not exactly one of the three
    // words must fail closed, never round to the muting outcome.
    for (const decision of ["Benign", "BENIGN", "benign ", "beningn", "no issue"]) {
      expect(
        parseJudgment(`{"decision":"${decision}","reason":"a reason here"}`),
      ).toBeNull();
    }
  });
});

describe("the reason survives intact", () => {
  it("keeps the sentence a human will read on the finding", () => {
    const parsed = parseJudgment(
      '{"decision":"benign","reason":"staging scratch column, nothing reads it"}',
    );

    expect(parsed?.reason).toBe("staging scratch column, nothing reads it");
  });
});
