import { describe, expect, it } from "vitest";
import { dedupeKeyFor } from "./incidents.js";

/**
 * The dedupe key is what makes at-least-once delivery survivable. Vendor
 * retries and our own job retries both land on it, so if it is unstable one
 * change becomes several incidents and the operator gets paged twice for the
 * same deletion — and if it collides, two genuinely different changes become
 * one and the second is silently dropped.
 */

const base = {
  connector: "airtable",
  externalId: "app123/tbl456/fld789",
  operation: "delete",
  vendorEventId: "evt-001",
};

describe("dedupeKeyFor", () => {
  it("is stable across calls", () => {
    expect(dedupeKeyFor(base)).toBe(dedupeKeyFor(base));
  });

  it("is stable regardless of property order", () => {
    const reordered = {
      vendorEventId: base.vendorEventId,
      operation: base.operation,
      externalId: base.externalId,
      connector: base.connector,
    };

    expect(dedupeKeyFor(reordered)).toBe(dedupeKeyFor(base));
  });

  it.each([
    ["connector", { ...base, connector: "n8n" }],
    ["externalId", { ...base, externalId: "app123/tbl456/fld000" }],
    ["operation", { ...base, operation: "rename" }],
    ["vendorEventId", { ...base, vendorEventId: "evt-002" }],
  ])("changes when %s changes", (_field, changed) => {
    expect(dedupeKeyFor(changed)).not.toBe(dedupeKeyFor(base));
  });

  it("does not collide when field values shift across the separator", () => {
    // A naive concatenation makes ("a:b", "c") and ("a", "b:c") the same
    // string. Two different changes collapsing into one incident means the
    // second is never alerted on at all.
    const left = dedupeKeyFor({ ...base, connector: "airtable:x", externalId: "y" });
    const right = dedupeKeyFor({ ...base, connector: "airtable", externalId: "x:y" });

    expect(left).not.toBe(right);
  });

  it("is a hex sha-256 digest, so it fits a fixed-width unique index", () => {
    expect(dedupeKeyFor(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
