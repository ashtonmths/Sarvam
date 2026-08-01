import { createHash } from "node:crypto";

/**
 * The single canonicalization used anywhere in Sadhak.
 *
 * The drift gate's whole value is that ~99% of ticks cost one comparison and
 * zero model requests. That only holds if an unchanged system hashes
 * identically every time — so the two ways it can fail matter asymmetrically:
 *
 *   Under-stripping (noise survives) → the hash changes on every tick, every
 *   tick opens a finding, and the agent burns the daily request cap
 *   dismissing canvas coordinates. Loud, expensive, self-announcing.
 *
 *   Over-stripping (signal removed) → real drift hashes identically and is
 *   never noticed. Silent, and it makes the map confidently wrong, which is
 *   worse than having no map.
 *
 * So the strip lists stay deliberately short. Anything not provably
 * structure-irrelevant is left in: waking the agent to dismiss something costs
 * one request, and missing a deleted field costs a customer's Saturday.
 */

/**
 * Keys removed wherever they appear, per connector. Every entry needs a reason
 * that survives the question "could this ever be the only evidence a
 * dependency changed?"
 */
export const STRIP_LISTS: Record<string, readonly string[]> = {
  // Canvas geometry moves when a human drags a node; the wiring is unchanged.
  // Runtime scratch space is state, not structure.
  n8n: ["position", "staticData", "pinData"],
  // Airtable's meta responses are already structure-only.
  airtable: [],
  // Catalog queries return exactly the columns we select.
  postgres: [],
  github: [],
  slack: [],
};

/**
 * Fetch-time envelope fields, stripped for every connector. These describe the
 * response, not the system: leaving them in makes every tick differ.
 *
 * Note what is *not* here. `updatedAt` and `versionId` stay, because they are
 * the cheap first-pass signal the tick uses to avoid a detail fetch — they
 * change exactly when the thing changed, which is the definition of signal.
 */
const ALWAYS_STRIP = ["requestId", "requestID", "x-request-id", "fetchedAt", "_ts"];

export interface CanonicalOptions {
  /** Connector slug, selecting a strip list. Unknown slugs strip nothing. */
  connector?: string;
  /** Extra keys to strip, for a caller with a narrower concern. */
  strip?: readonly string[];
}

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in place.
 *
 * Array order is preserved on purpose. Reordering the steps of a workflow can
 * change what it does, so sorting them would be over-stripping of the silent
 * kind. If a connector ever returns an unordered collection as an array, it
 * sorts it before hashing rather than this function guessing.
 */
export function canonicalize(value: unknown, options: CanonicalOptions = {}): unknown {
  const strip = new Set([
    ...ALWAYS_STRIP,
    ...(options.connector ? (STRIP_LISTS[options.connector] ?? []) : []),
    ...(options.strip ?? []),
  ]);

  return walk(value, strip);
}

function walk(value: unknown, strip: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => walk(entry, strip));

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (strip.has(key)) continue;
      // undefined disappears under JSON.stringify anyway; dropping it here
      // keeps `{a: undefined}` and `{}` hashing alike rather than by accident.
      const entry = source[key];
      if (entry === undefined) continue;
      out[key] = walk(entry, strip);
    }
    return out;
  }

  return value;
}

/** Canonical JSON text. Exported mainly so a failing hash can be diffed. */
export function canonicalJson(value: unknown, options: CanonicalOptions = {}): string {
  return JSON.stringify(canonicalize(value, options));
}

/** sha256 hex over the canonical form. */
export function canonicalHash(value: unknown, options: CanonicalOptions = {}): string {
  return createHash("sha256").update(canonicalJson(value, options)).digest("hex");
}

/**
 * The root hash for an instance: a hash over its entity scopes and their
 * hashes, so one comparison answers "did anything at all change here".
 *
 * Sorted by scope, because the order entities come back from a provider is not
 * a fact about the customer's system.
 */
export function rootHash(entityHashes: ReadonlyMap<string, string>): string {
  const sorted = [...entityHashes.entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Which scopes changed between two entity-hash maps. This is what turns
 * "something changed" into "exactly these things changed" without diffing the
 * world.
 */
export function diffScopes(
  documented: ReadonlyMap<string, string>,
  live: ReadonlyMap<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [scope, hash] of live) {
    const before = documented.get(scope);
    if (before === undefined) added.push(scope);
    else if (before !== hash) changed.push(scope);
  }
  for (const scope of documented.keys()) {
    if (!live.has(scope)) removed.push(scope);
  }

  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * The suppression key. A signature covers the scope and the *shape* of the
 * change, not its contents — so "this base gains a field again" can be muted
 * by a prior judgment, while a different kind of change to the same base still
 * wakes the loop.
 */
export function signatureFor(input: {
  connectorInstanceId: number;
  scope: string;
  kind: string;
  shape?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.connectorInstanceId,
        input.scope,
        input.kind,
        input.shape ?? "",
      ]),
    )
    .digest("hex");
}
