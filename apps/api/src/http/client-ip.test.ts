import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip.js";

/** A context stub with only the surface `clientIp` actually reads. */
function ctx(headers: Record<string, string>): Context {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
  } as unknown as Context;
}

describe("clientIp", () => {
  it("takes the last forwarded hop, not the first", () => {
    // The first entry is whatever the caller typed; only the last was written
    // by our own proxy.
    const ip = clientIp(ctx({ "x-forwarded-for": "1.2.3.4, 10.0.0.9, 172.18.0.5" }));

    expect(ip).toBe("172.18.0.5");
  });

  it("ignores a spoofed single-entry header appended to by the proxy", () => {
    const ip = clientIp(ctx({ "x-forwarded-for": "203.0.113.7, 198.51.100.2" }));

    expect(ip).toBe("198.51.100.2");
  });

  it("handles a single hop", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("folds an IPv4-mapped IPv6 address onto its IPv4 form", () => {
    // Otherwise the same client gets two buckets and double the rate budget.
    expect(clientIp(ctx({ "x-forwarded-for": "::ffff:203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
  });

  it("strips brackets from an IPv6 literal", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "[2001:db8::1]" }))).toBe("2001:db8::1");
  });

  it("falls back to x-real-ip when there is no forwarded chain", () => {
    expect(clientIp(ctx({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("reports unknown rather than guessing when there is no header", () => {
    expect(clientIp(ctx({}))).toBe("unknown");
  });

  it("skips empty entries produced by a trailing comma", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, " }))).toBe("5.6.7.8");
  });
});
