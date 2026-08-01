import { describe, expect, it } from "vitest";
import { backoffMs, MAX_BACKOFF_MS, settleAfterFailure } from "./backoff.js";

describe("backoffMs", () => {
  it("doubles from 30s per attempt", () => {
    const noJitter = () => 0;
    expect(backoffMs(1, noJitter)).toBe(30_000);
    expect(backoffMs(2, noJitter)).toBe(60_000);
    expect(backoffMs(3, noJitter)).toBe(120_000);
    expect(backoffMs(4, noJitter)).toBe(240_000);
  });

  it("caps at 30 minutes however many attempts have passed", () => {
    const noJitter = () => 0;
    expect(backoffMs(20, noJitter)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(100, noJitter)).toBe(MAX_BACKOFF_MS);
  });

  it("adds at most 25% jitter, so retries never align across workers", () => {
    expect(backoffMs(1, () => 0)).toBe(30_000);
    expect(backoffMs(1, () => 1)).toBe(37_500);
    expect(backoffMs(1, () => 0.5)).toBe(33_750);
  });

  it("treats a zero or negative attempt as the first", () => {
    expect(backoffMs(0, () => 0)).toBe(30_000);
    expect(backoffMs(-3, () => 0)).toBe(30_000);
  });
});

describe("settleAfterFailure", () => {
  it("requeues with backoff while attempts remain", () => {
    const settle = settleAfterFailure(2, 5, () => 0);
    expect(settle).toEqual({ state: "queued", runAfterMs: 60_000 });
  });

  it("dead-letters rather than dropping once attempts are exhausted", () => {
    expect(settleAfterFailure(5, 5).state).toBe("dead_letter");
    expect(settleAfterFailure(9, 5).state).toBe("dead_letter");
  });
});
