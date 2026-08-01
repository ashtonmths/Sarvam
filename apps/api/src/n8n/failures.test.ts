import { describe, expect, it } from "vitest";
import { __testing } from "./failures.js";

const { parseVendorDate } = __testing;

/**
 * The regression this guards is not hypothetical: an Invalid Date reaches
 * drizzle, drizzle calls `toISOString()` on it, that throws a RangeError, and
 * the throw escapes the poll before it re-enqueues itself — which stops
 * failure detection for that org until the process restarts.
 */
describe("parseVendorDate", () => {
  it("accepts a UTC timestamp", () => {
    expect(parseVendorDate("2026-08-01T10:00:00.000Z")?.toISOString()).toBe(
      "2026-08-01T10:00:00.000Z",
    );
  });

  it("accepts an explicit numeric offset", () => {
    expect(parseVendorDate("2026-08-01T15:30:00+05:30")?.toISOString()).toBe(
      "2026-08-01T10:00:00.000Z",
    );
  });

  it("returns null rather than an Invalid Date", () => {
    expect(parseVendorDate("garbage")).toBeNull();
    expect(parseVendorDate("")).toBeNull();
    expect(parseVendorDate(null)).toBeNull();
  });

  /**
   * Rejected, not silently offset. V8 reads a zone-less string in the
   * process's local zone, so accepting one would make the stored time depend
   * on how the container happens to be configured.
   */
  it("rejects a timestamp with no zone", () => {
    expect(parseVendorDate("2026-08-01T10:00:00")).toBeNull();
    expect(parseVendorDate("2026-08-01 10:00:00")).toBeNull();
  });
});
