import { describe, expect, it } from "vitest";
import { parseAnalysis, slackQueryFor, triage } from "./analyse.js";
import { signatureOf } from "./logs.js";

/**
 * The parts that decide what gets spent and what gets said.
 *
 * None of these need GitHub, Slack or a model, which is the point: triage
 * decides whether to spend a strong-tier call, the signature decides whether
 * precedent is found at all, and the parser decides whether a finding reaches
 * an engineer. Each is pure, and each fails silently in production if it is
 * wrong — a bad signature returns "no precedent" rather than an error.
 */

describe("triage", () => {
  it("routes a type error to the quick path", () => {
    const log =
      "src/embed.ts(34,3): error TS2345: Argument of type 'string' is not assignable.";
    expect(triage(log)).toEqual({ kind: "trivial", label: "TypeScript error" });
  });

  it("routes a missing import to the quick path", () => {
    expect(triage("Error: Cannot find module './config.js'")).toEqual({
      kind: "trivial",
      label: "missing import",
    });
  });

  it("routes a lint failure to the quick path", () => {
    const log =
      "apps/web/page.tsx:2:1 lint/style/useConst\n  ✖ This let declares a value never reassigned.\n  error";
    expect(triage(log).kind).toBe("trivial");
  });

  /**
   * The distinction the whole feature rests on. A failing assertion looks
   * precise — it prints expected and actual — but it never says why the value
   * started differing today, and that is the question the history answers.
   */
  it("sends a failing test down the full path", () => {
    const log = [
      "FAIL apps/api/src/gate/verdict.test.ts",
      "  × blocks a change that drops a column used by a report",
      "    expected 'BLOCK' to be 'WARN'",
    ].join("\n");
    expect(triage(log)).toEqual({ kind: "investigate" });
  });

  it("sends an unreadable log down the full path rather than guessing", () => {
    expect(triage("")).toEqual({ kind: "investigate" });
  });

  it("reports a compile error inside a test run as the compile error", () => {
    const log =
      "Running tests...\nsrc/lib.rs: error[E0308]: mismatched types\ntest result: FAILED";
    expect(triage(log)).toEqual({ kind: "trivial", label: "compile error" });
  });
});

describe("signatureOf", () => {
  /**
   * Two runs of one broken test share no exact line. If the signature did not
   * normalise them the precedent search would return nothing, and "we have
   * never seen this" is indistinguishable from "we did not look properly".
   */
  it("matches the same failure across two runs", () => {
    const first = [
      "2026-08-01T10:00:00.123Z FAIL /home/runner/work/app/src/pay.test.ts",
      "  × charges vat at 19% (412ms)",
      "  at /home/runner/work/app/src/pay.test.ts:88:14",
    ].join("\n");
    const second = [
      "2026-08-02T11:30:59.900Z FAIL /home/runner/work/app/src/pay.test.ts",
      "  × charges vat at 19% (503ms)",
      "  at /home/runner/work/app/src/pay.test.ts:91:14",
    ].join("\n");

    expect(signatureOf(first)).toBe(signatureOf(second));
  });

  it("keeps genuinely different failures apart", () => {
    const typeError = "src/a.ts(1,1): error TS2345: not assignable";
    const missing = "Error: Cannot find module './b.js'";
    expect(signatureOf(typeError)).not.toBe(signatureOf(missing));
  });

  it("is bounded, so one pathological line cannot blow the column", () => {
    expect(signatureOf("x".repeat(50_000)).length).toBeLessThanOrEqual(1000);
  });
});

describe("slackQueryFor", () => {
  /**
   * Nobody pastes a stack trace into Slack. They write the name of the thing
   * that broke, so that is what the query has to be built from.
   */
  it("pulls identifiers out of the error rather than searching the trace", () => {
    const query = slackQueryFor(
      "Run migrations",
      "error: column invoices_vat_rate does not exist\n  at ValidationError",
    );
    expect(query).toContain("Run migrations");
    expect(query).toContain("invoices_vat_rate");
  });

  it("stays within Slack's practical query length", () => {
    const query = slackQueryFor("step", "some_identifier_here ".repeat(200));
    expect(query.length).toBeLessThanOrEqual(200);
  });
});

describe("parseAnalysis", () => {
  it("accepts JSON wrapped in a fence, which models emit despite instructions", () => {
    const parsed = parseAnalysis(
      '```json\n{"cause":"the column was dropped","recommendation":"restore it","confidence":0.8,"evidence":[]}\n```',
    );
    expect(parsed?.cause).toBe("the column was dropped");
    expect(parsed?.confidence).toBe(0.8);
  });

  /**
   * A finding with no cause is not a thin finding, it is not a finding. Storing
   * one would put an empty conclusion in front of an engineer with Sadhak's
   * name on it.
   */
  it("rejects an analysis with no cause", () => {
    expect(
      parseAnalysis('{"recommendation":"do something","confidence":0.9}'),
    ).toBeNull();
  });

  it("rejects unparseable output rather than inventing a finding", () => {
    expect(parseAnalysis("I think the build broke because of the migration.")).toBeNull();
    expect(parseAnalysis(null)).toBeNull();
  });

  /** Models return 95 for "95%" often enough that this must not render as 9500%. */
  it("normalises a percentage-style confidence", () => {
    expect(parseAnalysis('{"cause":"x","confidence":95}')?.confidence).toBe(0.95);
  });

  it("clamps confidence into range", () => {
    expect(parseAnalysis('{"cause":"x","confidence":-3}')?.confidence).toBe(0);
  });

  it("drops evidence entries with no detail", () => {
    const parsed = parseAnalysis(
      '{"cause":"x","evidence":[{"source":"log","detail":"line 4"},{"source":"slack"}]}',
    );
    expect(parsed?.evidence).toEqual([{ source: "log", detail: "line 4" }]);
  });

  it("carries the inconclusive flag through", () => {
    expect(parseAnalysis('{"cause":"unclear","inconclusive":true}')?.inconclusive).toBe(
      true,
    );
  });
});
