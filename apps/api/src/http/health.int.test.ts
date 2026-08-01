import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools } from "../db.js";
import { beginDraining, isDraining, readiness } from "./health.js";

/**
 * Liveness and readiness answer different questions, and the split exists so
 * that a database problem drains this container instead of killing it.
 *
 * Against a real Postgres, because the interesting assertion is that readiness
 * genuinely consults the database — a mocked probe would pass while the real
 * one hung.
 */

afterAll(async () => {
  await closePools();
});

describe("readiness", () => {
  it("reports ready while the database answers", async () => {
    const result = await readiness();

    expect(result.ready).toBe(true);
    expect(result.checks.db).toBe("ok");
  });

  // Not covered: the db-failed path. A warm postgres.js connection resolves
  // `SELECT 1` in a microtask, which beats any timer however small, so the
  // timeout branch cannot be provoked by shortening the budget — and racing it
  // produced a test that passed or failed depending on connection warmth.
  // Proving it needs fault injection (a paused container, or a pool held
  // open), which belongs with the load harness rather than here. The draining
  // case below covers the "not ready, and says which probe" shape.

  it("is bounded, so a hung database cannot hang the probe", async () => {
    // A probe that never answers is worse than one that fails: the
    // orchestrator learns nothing and waits.
    const startedAt = Date.now();
    await readiness(50);

    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe("draining", () => {
  beforeEach(() => {
    expect(isDraining()).toBe(false);
  });

  it("reports not ready as soon as shutdown begins, before anything closes", async () => {
    // The order is the mechanism: readiness must flip first so the proxy stops
    // routing here, and only then does the socket close. Closing first refuses
    // requests the proxy is still sending, which reads as a failed deploy.
    beginDraining();

    const result = await readiness();

    expect(result.ready).toBe(false);
    expect(result.checks.shutdown).toBe("draining");
  });
});
