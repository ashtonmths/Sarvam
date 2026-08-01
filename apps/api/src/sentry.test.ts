import { describe, expect, it } from "vitest";
import { REDACTED } from "./log.js";
import { __scrubForTest, captureError } from "./sentry.js";

/**
 * The two properties worth pinning here are both about what does *not* leave
 * the process: which errors are reported at all, and whether a secret can ride
 * along in one that is.
 *
 * There is no DSN configured in tests, so the SDK never initializes and every
 * capture is already a no-op. That makes "does it send" untestable without a
 * live Sentry, and makes the filtering and scrubbing — which are pure
 * functions of the input — exactly the parts that can be tested honestly.
 */

describe("scrub", () => {
  it("redacts every key name the logger redacts", () => {
    // The lists are shared for this reason: the day they drift is the day a
    // secret that never reached a log line reaches an error report instead.
    const bareKeys = REDACTED.filter((path) => !path.includes(".") && path !== "*");

    const payload = Object.fromEntries(bareKeys.map((key) => [key, "sensitive"]));
    const scrubbed = __scrubForTest(payload) as Record<string, string>;

    for (const key of bareKeys) {
      expect(scrubbed[key], `${key} should be redacted`).toBe("[Redacted]");
    }
  });

  it("redacts regardless of case", () => {
    const scrubbed = __scrubForTest({ Authorization: "Bearer x", TOKEN: "y" }) as Record<
      string,
      string
    >;
    expect(scrubbed.Authorization).toBe("[Redacted]");
    expect(scrubbed.TOKEN).toBe("[Redacted]");
  });

  it("reaches into nested objects and arrays", () => {
    const scrubbed = __scrubForTest({
      connector: { config: { apiKey: "sk-live-secret" } },
      attempts: [{ token: "t1" }, { token: "t2" }],
    }) as { connector: { config: { apiKey: string } }; attempts: { token: string }[] };

    expect(scrubbed.connector.config.apiKey).toBe("[Redacted]");
    expect(scrubbed.attempts.map((a) => a.token)).toEqual(["[Redacted]", "[Redacted]"]);
  });

  it("leaves innocent values alone", () => {
    const scrubbed = __scrubForTest({ nodeId: 42, name: "invoices.vat_rate" });
    expect(scrubbed).toEqual({ nodeId: 42, name: "invoices.vat_rate" });
  });

  it("stops rather than recursing forever on a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    // The depth cap is what makes this safe; without it an error carrying a
    // self-referential context would hang the reporter.
    expect(() => __scrubForTest(cyclic)).not.toThrow();
  });
});

describe("captureError", () => {
  it("is inert with no DSN configured", () => {
    // The whole posture: Sentry being absent must never affect anything,
    // including by throwing on the way to not reporting.
    expect(() => captureError(new Error("boom"), { requestId: "r1" })).not.toThrow();
  });
});
