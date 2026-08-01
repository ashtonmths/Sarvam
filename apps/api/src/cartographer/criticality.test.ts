import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRITICALITY,
  propagateStructural,
  seedCriticality,
  seedFromHost,
  seedFromName,
} from "./criticality.js";

describe("name heuristics", () => {
  it("scores revenue-touching names 1.0", () => {
    for (const name of ["invoices", "vat_rate", "stripe_payouts", "billing-sync"]) {
      expect(seedFromName(name)).toBe(1.0);
    }
  });

  it("scores customer-facing names 0.7", () => {
    expect(seedFromName("customers")).toBe(0.7);
    expect(seedFromName("onboarding_emails")).toBe(0.7);
  });

  it("scores sandbox names 0.1", () => {
    expect(seedFromName("scratch_tmp")).toBe(0.1);
    expect(seedFromName("demo playground")).toBe(0.1);
  });

  it("falls back to internal for an unmatched name", () => {
    expect(seedFromName("widget_registry")).toBe(DEFAULT_CRITICALITY);
  });

  it("takes the first match, so revenue wins over sandbox in a mixed name", () => {
    expect(seedFromName("invoices_test")).toBe(1.0);
  });
});

describe("structural rules", () => {
  it("scores payment-processor hosts 1.0 regardless of the node name", () => {
    expect(seedFromHost("api.stripe.com")).toBe(1.0);
    expect(seedFromHost("checkout.paypal.com")).toBe(1.0);
    expect(seedFromHost("api.internal.example.com")).toBe(DEFAULT_CRITICALITY);
  });

  it("lifts a blandly-named endpoint whose host is a processor", () => {
    const score = seedCriticality({
      kind: "endpoint",
      name: "sync helper",
      metadata: { host: "api.stripe.com" },
    });
    expect(score).toBe(1.0);
  });
});

describe("propagateStructural", () => {
  it("makes a blandly-named workflow as critical as what it writes to", () => {
    const nodes = new Map([
      ["wf", { kind: "workflow", criticality: 0.4 }],
      ["step", { kind: "step", criticality: 0.4 }],
      ["invoices", { kind: "table", criticality: 1.0 }],
    ]);
    propagateStructural(nodes, [
      { src: "step", dst: "invoices", kind: "WRITES_TO" },
      { src: "wf", dst: "step", kind: "DERIVES_FROM" },
    ]);
    expect(nodes.get("step")?.criticality).toBe(1.0);
    expect(nodes.get("wf")?.criticality).toBe(1.0);
  });

  it("makes a credential as critical as its most critical dependent", () => {
    const nodes = new Map([
      ["step", { kind: "step", criticality: 1.0 }],
      ["cred", { kind: "credential", criticality: 0.4 }],
    ]);
    propagateStructural(nodes, [
      { src: "step", dst: "cred", kind: "AUTHENTICATES_WITH" },
    ]);
    expect(nodes.get("cred")?.criticality).toBe(1.0);
  });

  it("never lowers a score", () => {
    const nodes = new Map([
      ["wf", { kind: "workflow", criticality: 1.0 }],
      ["step", { kind: "step", criticality: 0.1 }],
    ]);
    propagateStructural(nodes, [{ src: "wf", dst: "step", kind: "DERIVES_FROM" }]);
    expect(nodes.get("wf")?.criticality).toBe(1.0);
  });
});
