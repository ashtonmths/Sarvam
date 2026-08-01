import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  canonicalize,
  canonicalJson,
  diffScopes,
  rootHash,
  STRIP_LISTS,
  signatureFor,
} from "./hash.js";

/**
 * The strip lists are the risky part, and the two ways they fail are not
 * symmetric. Under-stripping is loud: every tick opens a finding and burns the
 * daily request cap. Over-stripping is silent: real drift hashes identically
 * and nobody ever hears about it, which makes the map confidently wrong.
 *
 * So these tests are heavier on "this must still be detected" than on "this
 * must be ignored".
 */

describe("canonicalize", () => {
  it("orders object keys so serialization order cannot change the hash", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("orders keys at every depth, not just the top", () => {
    const a = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const b = { outer: { a: { b: 3, y: 2 }, z: 1 } };

    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("preserves array order, because reordering steps changes behaviour", () => {
    // Sorting arrays would be over-stripping of the silent kind: a workflow
    // whose steps were reordered does something different.
    expect(canonicalHash({ steps: ["a", "b"] })).not.toBe(
      canonicalHash({ steps: ["b", "a"] }),
    );
  });

  it("treats an absent key and an undefined one as the same", () => {
    expect(canonicalHash({ a: 1, b: undefined })).toBe(canonicalHash({ a: 1 }));
  });

  it("distinguishes null from absent, because null is a stated value", () => {
    expect(canonicalHash({ a: 1, b: null })).not.toBe(canonicalHash({ a: 1 }));
  });

  it("does not confuse a number with its string form", () => {
    expect(canonicalHash({ v: 1 })).not.toBe(canonicalHash({ v: "1" }));
  });
});

describe("strip lists", () => {
  it("ignores n8n canvas coordinates, which move when a human drags a node", () => {
    const before = { name: "sync", position: [100, 200], nodes: [{ position: [0, 0] }] };
    const after = { name: "sync", position: [900, 40], nodes: [{ position: [7, 7] }] };

    expect(canonicalHash(before, { connector: "n8n" })).toBe(
      canonicalHash(after, { connector: "n8n" }),
    );
  });

  it("ignores n8n runtime scratch space, which is state and not structure", () => {
    const before = { name: "sync", staticData: { lastId: 1 } };
    const after = { name: "sync", staticData: { lastId: 99_999 } };

    expect(canonicalHash(before, { connector: "n8n" })).toBe(
      canonicalHash(after, { connector: "n8n" }),
    );
  });

  it("ignores fetch-time envelope fields for every connector", () => {
    const before = { name: "x", requestId: "req-1", fetchedAt: "2026-01-01" };
    const after = { name: "x", requestId: "req-2", fetchedAt: "2026-07-26" };

    expect(canonicalHash(before)).toBe(canonicalHash(after));
  });

  it("keeps updatedAt and versionId, which are the cheap change signal", () => {
    // The tick uses these to avoid a detail fetch. Stripping them would remove
    // exactly the evidence the short-circuit depends on.
    expect(canonicalHash({ updatedAt: "a" }, { connector: "n8n" })).not.toBe(
      canonicalHash({ updatedAt: "b" }, { connector: "n8n" }),
    );
    expect(canonicalHash({ versionId: "1" }, { connector: "n8n" })).not.toBe(
      canonicalHash({ versionId: "2" }, { connector: "n8n" }),
    );
  });

  it("strips nothing for a connector with no list", () => {
    expect(STRIP_LISTS.postgres).toEqual([]);
    expect(canonicalHash({ position: [1, 2] }, { connector: "postgres" })).not.toBe(
      canonicalHash({ position: [3, 4] }, { connector: "postgres" }),
    );
  });

  it("does not let one connector's strip list leak into another", () => {
    // position is noise on an n8n canvas and could be meaningful elsewhere.
    const a = canonicalHash({ position: [1, 2] }, { connector: "airtable" });
    const b = canonicalHash({ position: [9, 9] }, { connector: "airtable" });

    expect(a).not.toBe(b);
  });
});

describe("what must still be detected", () => {
  it.each([
    [
      "a renamed field",
      { fields: [{ name: "vat_rate" }] },
      { fields: [{ name: "vat" }] },
    ],
    [
      "a removed field",
      { fields: [{ name: "a" }, { name: "b" }] },
      { fields: [{ name: "a" }] },
    ],
    [
      "an added field",
      { fields: [{ name: "a" }] },
      { fields: [{ name: "a" }, { name: "b" }] },
    ],
    [
      "a retyped field",
      { fields: [{ name: "a", type: "text" }] },
      { fields: [{ name: "a", type: "number" }] },
    ],
    [
      "a disabled step",
      { nodes: [{ id: 1, disabled: false }] },
      { nodes: [{ id: 1, disabled: true }] },
    ],
    [
      "a rewired connection",
      { connections: { a: ["b"] } },
      { connections: { a: ["c"] } },
    ],
  ])("detects %s", (_label, before, after) => {
    expect(canonicalHash(before, { connector: "n8n" })).not.toBe(
      canonicalHash(after, { connector: "n8n" }),
    );
  });
});

describe("rootHash", () => {
  it("is independent of the order entities came back in", () => {
    const a = new Map([
      ["workflow/1", "aaa"],
      ["workflow/2", "bbb"],
    ]);
    const b = new Map([
      ["workflow/2", "bbb"],
      ["workflow/1", "aaa"],
    ]);

    expect(rootHash(a)).toBe(rootHash(b));
  });

  it("changes when any entity changes", () => {
    const before = new Map([["workflow/1", "aaa"]]);
    const after = new Map([["workflow/1", "zzz"]]);

    expect(rootHash(before)).not.toBe(rootHash(after));
  });

  it("changes when an entity is added or removed", () => {
    const one = new Map([["workflow/1", "aaa"]]);
    const two = new Map([
      ["workflow/1", "aaa"],
      ["workflow/2", "bbb"],
    ]);

    expect(rootHash(one)).not.toBe(rootHash(two));
  });

  it("is stable for an unchanged instance, which is what the short-circuit rests on", () => {
    const entities = new Map([
      ["workflow/1", "aaa"],
      ["base/appX", "bbb"],
    ]);

    expect(rootHash(entities)).toBe(rootHash(new Map(entities)));
  });
});

describe("diffScopes", () => {
  it("names exactly what changed, rather than reporting the world", () => {
    const documented = new Map([
      ["workflow/1", "aaa"],
      ["workflow/2", "bbb"],
      ["workflow/3", "ccc"],
    ]);
    const live = new Map([
      ["workflow/1", "aaa"],
      ["workflow/2", "CHANGED"],
      ["workflow/4", "ddd"],
    ]);

    expect(diffScopes(documented, live)).toEqual({
      added: ["workflow/4"],
      removed: ["workflow/3"],
      changed: ["workflow/2"],
    });
  });

  it("reports nothing for an identical pair", () => {
    const same = new Map([["workflow/1", "aaa"]]);

    expect(diffScopes(same, new Map(same))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });
});

describe("signatureFor", () => {
  it("is stable for the same scope and change shape", () => {
    const input = { connectorInstanceId: 1, scope: "base/appX", kind: "hash_change" };

    expect(signatureFor(input)).toBe(signatureFor(input));
  });

  it("separates different scopes, instances and kinds", () => {
    const base = { connectorInstanceId: 1, scope: "base/appX", kind: "hash_change" };

    expect(signatureFor({ ...base, scope: "base/appY" })).not.toBe(signatureFor(base));
    expect(signatureFor({ ...base, connectorInstanceId: 2 })).not.toBe(
      signatureFor(base),
    );
    expect(signatureFor({ ...base, kind: "staleness" })).not.toBe(signatureFor(base));
  });

  it("does not collide when values shift across the separator", () => {
    const left = signatureFor({ connectorInstanceId: 1, scope: "a:b", kind: "c" });
    const right = signatureFor({ connectorInstanceId: 1, scope: "a", kind: "b:c" });

    expect(left).not.toBe(right);
  });
});

describe("canonicalize returns data, not text", () => {
  it("can be inspected when a hash mismatch needs explaining", () => {
    expect(canonicalize({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
  });
});
