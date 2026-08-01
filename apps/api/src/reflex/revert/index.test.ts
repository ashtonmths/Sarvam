import { readFileSync } from "node:fs";
import type { ReflexIncident } from "@sadhak/shared/schema";
import { describe, expect, it } from "vitest";
import { execute, isRevertible, REVERT_ACTIONS, revertActionFor } from "./index.js";

/**
 * Reverts are the only writes Sadhak performs against a customer's systems, so
 * the guards around them are the ones worth pinning: which connectors may be
 * reverted at all, that an escalation can never ship without a usable recovery
 * action, and that the write path never asks for the read grant.
 */

describe("isRevertible", () => {
  it("admits exactly the connectors with an executor", () => {
    expect(isRevertible("airtable")).toBe(true);
    expect(isRevertible("n8n")).toBe(true);
  });

  it.each(["postgres", "github", "slack", "", "AIRTABLE"])("refuses %s", (connector) => {
    // Postgres changes arrive through pull requests and are hard-gated;
    // there is nothing to revert after the fact, and pretending otherwise
    // would offer a button that cannot work.
    expect(isRevertible(connector)).toBe(false);
  });
});

describe("revertActionFor", () => {
  it("returns the inline recovery step for a revertible connector", () => {
    for (const connector of ["airtable", "n8n"]) {
      expect(revertActionFor(connector).length).toBeGreaterThanOrEqual(40);
    }
  });

  it("throws rather than escalating without a recovery action", () => {
    // There is no revert runbook to link to — Plan 16 is deferred — so a
    // shipped alert must carry the recovery step in its body or not ship.
    expect(() => revertActionFor("postgres")).toThrow(/refusing to escalate/i);
  });

  it("throws on an action too short to be usable at 2am", () => {
    expect(() => revertActionFor("unknown-connector")).toThrow();
  });

  it("gives every registered action real instructions, not a placeholder", () => {
    for (const [connector, action] of Object.entries(REVERT_ACTIONS)) {
      expect(action.length, `${connector} action is too short`).toBeGreaterThanOrEqual(
        40,
      );
      expect(action, `${connector} action is a placeholder`).not.toMatch(
        /TODO|TBD|FIXME/i,
      );
    }
  });
});

describe("execute", () => {
  it("refuses a connector with no executor instead of reporting success", async () => {
    const incident = { connector: "postgres" } as ReflexIncident;

    const outcome = await execute(incident);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/no revert executor/i);
  });
});

describe("the write path never asks for the read grant", () => {
  // The module comment claims this; without a test it is only a claim. A
  // revert running under the read-only crawl credential would fail at the
  // vendor, but a revert that silently *succeeded* under an over-broad read
  // grant would mean the read credential was never read-only.
  it.each(["airtable.ts", "n8n.ts"])("%s requests scope 'write'", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");

    const scopes = [...source.matchAll(/getCredential\([^)]*?"(read|write)"/gs)].map(
      (m) => m[1],
    );

    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).not.toContain("read");
  });
});
